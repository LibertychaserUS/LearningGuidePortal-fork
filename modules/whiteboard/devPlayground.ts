// The DEV playground's server side (2026-11-02): the real whiteboard and
// presentation services over in-memory stores, a fixed roster, and a stand-in
// for the LiveKit room that pushes packets to each browser over Server-Sent
// Events. Only app/api/dev/whiteboard uses it, and that route answers in
// `next dev` only.
//
// The room keeps LiveKit's semantics: the server's packets carry no sender
// identity, member packets carry theirs, destinationIdentities narrows who
// receives, and the "loss" switch drops packets the way a lossy channel or a
// reconnect would.

import { randomUUID } from "node:crypto";
import { createConverter, createOfficeConverter, createWebConverter, inspectPdf, resolveHost } from "./converters";
import { DEV_HOSTS, DEV_MEMBERS } from "./devIdentities";
import { isPublicAddress } from "./presentation";
import { createMemoryPresentationStore, createPresentationService } from "./presentationService";
import { createMemoryWhiteboardStore, createWhiteboardService, type WhiteboardBroadcaster } from "./service";
import { WHITEBOARD_INK_TOPIC, WHITEBOARD_TOPIC } from "./wire";


export type DevPacket = { topic: string; sender: string; payload: string };

type Listener = { identity: string; send: (packet: DevPacket) => void };

function create() {
  const listeners = new Set<Listener>();
  let loss = false;
  const roster = async () => ({ hostIds: DEV_HOSTS, memberIds: DEV_MEMBERS });
  const dropped = () => loss && Math.random() < 0.3;

  function deliver(packet: DevPacket, to?: ReadonlyArray<string>, except?: string) {
    for (const listener of listeners) {
      if (listener.identity === except || (to && !to.includes(listener.identity)) || dropped()) continue;
      listener.send(packet);
    }
  }

  const broadcast: WhiteboardBroadcaster = async ({ message, destinationIdentities }) => {
    deliver({ topic: WHITEBOARD_TOPIC, sender: "", payload: JSON.stringify(message) }, destinationIdentities);
  };

  const whiteboardStore = createMemoryWhiteboardStore();
  const trustedOrigins = (process.env.WHITEBOARD_DEV_IMPORT_ORIGINS || "").split(",").map((item) => item.trim()).filter(Boolean);
  // Defined before the web converter, which asks it about every request.
  let allowed: (url: URL) => Promise<boolean> = async () => false;
  const presentations = createPresentationService({
    store: createMemoryPresentationStore(),
    convert: createConverter({ office: createOfficeConverter(), web: createWebConverter({ allowed: (url) => allowed(url) }) }),
    inspect: inspectPdf,
    resolve: resolveHost,
    isPublicAddress,
    roster,
    broadcast,
    currentPresentation: async (sessionId) => (await whiteboardStore.readStage(sessionId))?.presentation.id ?? null,
    newId: () => `p_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    now: () => new Date().toISOString(),
    trustedOrigins
  });
  allowed = (url) => presentations.allowedRequest(url);
  const whiteboard = createWhiteboardService({ store: whiteboardStore, roster, broadcast, presentations: presentations.ref });

  return {
    whiteboard,
    presentations,
    roster,
    subscribe(identity: string, send: (packet: DevPacket) => void) {
      const listener = { identity, send };
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // A member's localParticipant.publishData on the ink topic: stamped with
    // the sender, never echoed back to them, optionally narrowed.
    publishInk(sender: string, payload: string, to?: ReadonlyArray<string>) {
      deliver({ topic: WHITEBOARD_INK_TOPIC, sender, payload }, to, sender);
    },
    setLoss(on: boolean) {
      loss = on;
    }
  };
}

type Playground = ReturnType<typeof create>;

// One instance per server process, shared by every compiled route bundle.
export function devPlayground(): Playground {
  const holder = globalThis as typeof globalThis & { __lgWhiteboardPlayground?: Playground };
  holder.__lgWhiteboardPlayground ??= create();
  return holder.__lgWhiteboardPlayground;
}

export function resetDevPlayground() {
  delete (globalThis as typeof globalThis & { __lgWhiteboardPlayground?: Playground }).__lgWhiteboardPlayground;
}
