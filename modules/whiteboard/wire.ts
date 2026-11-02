import { BOARD, WHITEBOARD_COLORS, WHITEBOARD_LIMITS, WHITEBOARD_TOOLS, type BoardOp, type WhiteboardTool } from "./domain";
import type { Presentation } from "./presentation";
import { parseBoardKey, type Stage } from "./stage";

// Two LiveKit data topics. The room's chat, hands and AI Tutor stay on the
// default topic, so none of the parsers ever sees another's packets.
//  - lg.whiteboard: the stage, committed ops and (to hosts) courseware
//    conversion progress, sent by the server only (RoomService.SendData,
//    reliable).
//  - lg.whiteboard.ink: ink still being drawn, sent member to member
//    (lossy). Shown as a fading preview, never stored, never trusted as board.
export const WHITEBOARD_TOPIC = "lg.whiteboard";
export const WHITEBOARD_INK_TOPIC = "lg.whiteboard.ink";

export type WhiteboardMessage =
  | { kind: "stage"; stage: Stage }
  | { kind: "op"; board: string; op: BoardOp }
  | { kind: "presentation"; presentation: Presentation };

// A shape still being drawn. Freehand tools send the new points since the
// last preview; two-point tools send their current start and end.
export type InkPreview = { board: string; strokeId: string; tool: WhiteboardTool; color: string; width: number; points: ReadonlyArray<readonly [number, number]>; done?: boolean };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeWhiteboardMessage(message: WhiteboardMessage) {
  return encoder.encode(JSON.stringify(message));
}

export function encodeInk(ink: InkPreview) {
  return encoder.encode(JSON.stringify(ink));
}

function json(raw: Uint8Array): Record<string, unknown> | null {
  try {
    const value = JSON.parse(decoder.decode(raw));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function boardOf(value: unknown) {
  try {
    parseBoardKey(value);
    return value as string;
  } catch {
    return null;
  }
}

// Picks whiteboard packets out of the raw engine stream the room already
// watches (group-study/roomData.ts roomDataPacket). The sender stamp is empty
// only for RoomService.SendData, i.e. the server.
export function whiteboardPacket(packet: { participantIdentity?: string; value?: { case?: string; value?: unknown } }): { topic: string; payload: Uint8Array; senderIdentity: string } | null {
  if (packet.value?.case !== "user") return null;
  const user = packet.value.value as { payload?: unknown; topic?: unknown } | undefined;
  if ((user?.topic !== WHITEBOARD_TOPIC && user?.topic !== WHITEBOARD_INK_TOPIC) || !(user.payload instanceof Uint8Array)) return null;
  return { topic: user.topic, payload: user.payload, senderIdentity: typeof packet.participantIdentity === "string" ? packet.participantIdentity : "" };
}

// Trust boundary: the stage and committed ops are accepted from the server
// only. Any member can publish on any topic, so a packet with a sender
// identity is a forgery.
export function parseWhiteboardMessage(raw: Uint8Array, senderIdentity: string): WhiteboardMessage | null {
  if (senderIdentity) return null;
  const message = json(raw);
  if (!message) return null;
  if (message.kind === "stage") {
    const stage = message.stage as Record<string, unknown> | undefined;
    if (!stage || typeof stage.sessionId !== "string" || !Number.isInteger(stage.version) || !Number.isInteger(stage.page) || !Array.isArray(stage.pens)) return null;
    return { kind: "stage", stage: stage as unknown as Stage };
  }
  if (message.kind === "op") {
    const board = boardOf(message.board);
    const op = message.op as Record<string, unknown> | undefined;
    if (!board || !op || !Number.isInteger(op.seq) || (op.seq as number) < 1) return null;
    if ((op.kind === "stroke" && op.stroke && typeof op.stroke === "object") || (op.kind === "erase" && typeof op.strokeId === "string") || op.kind === "clear") {
      return { kind: "op", board, op: op as unknown as BoardOp };
    }
  }
  if (message.kind === "presentation") {
    const presentation = message.presentation as Record<string, unknown> | undefined;
    if (!presentation || typeof presentation.id !== "string" || typeof presentation.status !== "string") return null;
    return { kind: "presentation", presentation: presentation as unknown as Presentation };
  }
  return null;
}

// Ink comes from a member and is only ever drawn as a preview, so it is
// clamped to the board and the palette and nothing more.
export function parseInk(raw: Uint8Array, senderIdentity: string): InkPreview | null {
  if (!senderIdentity) return null;
  const ink = json(raw);
  const board = ink ? boardOf(ink.board) : null;
  if (!ink || !board || typeof ink.strokeId !== "string" || !Array.isArray(ink.points)) return null;
  const color = WHITEBOARD_COLORS.find((item) => item === ink.color);
  const tool = WHITEBOARD_TOOLS.find((item) => item === ink.tool && item !== "text");
  if (!color || !tool || !Number.isInteger(ink.width)) return null;
  const points = ink.points.slice(0, 200).filter((point): point is [number, number] => Array.isArray(point) && Number.isInteger(point[0]) && Number.isInteger(point[1]))
    .map(([x, y]) => [Math.min(BOARD.width, Math.max(0, x)), Math.min(BOARD.maxHeight, Math.max(0, y))] as [number, number]);
  return { board, strokeId: ink.strokeId.slice(0, 64), tool, color, width: Math.min(WHITEBOARD_LIMITS.maxWidth, Math.max(1, ink.width as number)), points, ...(ink.done === true ? { done: true } : {}) };
}
