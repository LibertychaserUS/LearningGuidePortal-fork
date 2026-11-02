"use client";

// The browser side of the playground API (app/api/dev/whiteboard). Each call
// carries the screen's identity; production uses the signed-in session and
// the Study Group routes instead, with the same request and response shapes.

import type { BoardOp, Stroke } from "@/modules/whiteboard/domain";
import type { Presentation } from "@/modules/whiteboard/presentation";
import type { Role, Stage } from "@/modules/whiteboard/stage";

export class ApiError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

// The packet shape LiveKit's engine hands the room (roomData.ts), so the same
// whiteboardPacket() picks whiteboard packets out of both.
export type RoomPacket = { participantIdentity?: string; value?: { case?: string; value?: { payload?: Uint8Array; topic?: string } } };

export type ClassroomClient = ReturnType<typeof createClassroomClient>;

export function createClassroomClient(sessionId: string, identity: string) {
  const base = `/api/dev/whiteboard/${encodeURIComponent(sessionId)}`;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "x-dev-user": identity, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const result = await response.json().catch(() => ({ code: "network_error" }));
    if (!response.ok) throw new ApiError(result.code || "network_error");
    return result.data as T;
  }

  return {
    identity,
    open: () => call<Stage>("POST", "/open", {}),
    stage: () => call<{ role: Role; stage: Stage }>("GET", "/stage"),
    command: (command: unknown) => call<Stage>("POST", "/commands", { command }),
    ops: (board: string, after: number) => call<BoardOp[]>("GET", `/ops?board=${encodeURIComponent(board)}&after=${after}`),
    draw: (board: string, stroke: Stroke) => call<BoardOp>("POST", "/strokes", { board, stroke }),
    erase: (board: string, strokeId: string) => call<BoardOp>("POST", "/erase", { board, strokeId }),
    clear: (board: string) => call<BoardOp | null>("POST", "/clear", { board }),
    // localParticipant.publishData(…, { reliable: false, topic, destinationIdentities })
    publishInk: (ink: string, to?: string[]) => call<boolean>("POST", "/ink", { ink, ...(to ? { to } : {}) }).catch(() => false),
    presentations: () => call<Presentation[]>("GET", "/presentations"),
    importWeb: (url: string) => call<Presentation>("POST", "/presentations", { url }),
    removePresentation: (id: string) => call<boolean>("DELETE", `/presentations/${encodeURIComponent(id)}`),
    setLoss: (on: boolean) => call<boolean>("POST", "/loss", { on }),

    // XMLHttpRequest for upload progress, as BigBlueButton shows it.
    upload(file: File, onProgress: (percent: number) => void) {
      return new Promise<Presentation>((resolve, reject) => {
        const request = new XMLHttpRequest();
        const form = new FormData();
        form.append("file", file);
        request.open("POST", `${base}/presentations`);
        request.setRequestHeader("x-dev-user", identity);
        request.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100)); };
        request.onload = () => {
          let result: { code?: string; data?: Presentation } = {};
          try { result = JSON.parse(request.responseText); } catch { /* not JSON */ }
          if (request.status >= 200 && request.status < 300 && result.data) resolve(result.data);
          else reject(new ApiError(result.code || "network_error"));
        };
        request.onerror = () => reject(new ApiError("network_error"));
        request.send(form);
      });
    },

    // The converted PDF, read once per presentation and shared by every view.
    async file(id: string) {
      const response = await fetch(`${base}/presentations/${encodeURIComponent(id)}/file`, { headers: { "x-dev-user": identity } });
      if (!response.ok) throw new ApiError("not_found");
      return new Uint8Array(await response.arrayBuffer());
    },

    // The room: packets pushed by the server, in LiveKit's packet shape.
    join(deliver: (packet: RoomPacket) => void, onOpen: () => void) {
      const source = new EventSource(`${base}/events?as=${encodeURIComponent(identity)}`);
      const encoder = new TextEncoder();
      source.onopen = onOpen;
      source.onmessage = (event) => {
        try {
          const packet = JSON.parse(event.data) as { topic: string; sender: string; payload: string };
          deliver({ participantIdentity: packet.sender, value: { case: "user", value: { topic: packet.topic, payload: encoder.encode(packet.payload) } } });
        } catch { /* ignore a malformed packet */ }
      };
      return () => source.close();
    }
  };
}
