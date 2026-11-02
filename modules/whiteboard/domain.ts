// Shared whiteboard for a Live Session (prototype, 2026-10-29; tools and
// courseware pages 2026-11-02, modelled on BigBlueButton).
//
// Each board is a log of operations owned by the server. A finished shape,
// an erase or a clear is a command: validated, appended with the next
// sequence number, stored, and only then broadcast over LiveKit. The browser
// rebuilds a board by replaying its log, so a late joiner or a lost packet is
// repaired by reading the ops after the last sequence it has.
//
// Ink that is still being drawn is not part of a board. It travels as a
// lossy member-to-member preview (wire.ts) and is thrown away; only the
// finished shape, sent to the server, becomes durable.
//
// Who may draw on or see which board is the classroom's business (stage.ts).
// This file is pure: no I/O, no clock, no LiveKit.

// Coordinates are integers. x runs 0..10000 across the page; y runs down in
// the same unit, so a 16:9 slide ends at 5625 and an A4 portrait page at
// 14142. Every screen size draws the same picture.
export const BOARD = { width: 10_000, maxHeight: 20_000 } as const;

export const WHITEBOARD_LIMITS = {
  maxPoints: 600,
  minWidth: 4,
  maxWidth: 800,
  maxTextLength: 500,
  // A reliable LiveKit data packet should stay under 15 KiB; one op must fit.
  maxOpBytes: 12_000,
  maxStrokes: 3_000
} as const;

// BigBlueButton's twelve whiteboard colours, in its order and with its names
// (black, white, red, orange, electric lime, lime, cyan, dodger blue, blue,
// violet, magenta, silver); the shades are softened to sit on slides.
export const WHITEBOARD_COLORS = ["#101828", "#ffffff", "#e5484d", "#f76b15", "#c2e000", "#30a46c", "#05a2c2", "#0090ff", "#3e63dd", "#8e4ec6", "#d6409f", "#8b8d98"] as const;

// Freehand tools carry their points; the two-point tools carry start and end;
// text carries its anchor point and the words.
export const WHITEBOARD_TOOLS = ["pen", "highlighter", "line", "arrow", "rect", "ellipse", "triangle", "text"] as const;
export type WhiteboardTool = (typeof WHITEBOARD_TOOLS)[number];
export const TWO_POINT_TOOLS: ReadonlyArray<WhiteboardTool> = ["line", "arrow", "rect", "ellipse", "triangle"];

export type BoardPoint = readonly [number, number];

export type Stroke = Readonly<{
  id: string;
  authorId: string;
  tool: WhiteboardTool;
  color: (typeof WHITEBOARD_COLORS)[number];
  // Line width, or the font size for text.
  width: number;
  points: ReadonlyArray<BoardPoint>;
  text?: string;
}>;

export type BoardOp = Readonly<
  | { seq: number; kind: "stroke"; stroke: Stroke }
  | { seq: number; kind: "erase"; strokeId: string; byId: string }
  | { seq: number; kind: "clear"; byId: string }
>;

export type BoardOpInput =
  | { kind: "stroke"; stroke: Stroke }
  | { kind: "erase"; strokeId: string; byId: string }
  | { kind: "clear"; byId: string };

export type Board = Readonly<{ seq: number; strokes: ReadonlyArray<Stroke> }>;

export type WhiteboardErrorCode = "invalid_command" | "forbidden" | "not_found" | "board_full" | "version_conflict";

export class WhiteboardError extends Error {
  readonly code: WhiteboardErrorCode;

  constructor(code: WhiteboardErrorCode) {
    super(code);
    this.name = "WhiteboardError";
    this.code = code;
  }
}

export const EMPTY_BOARD: Board = { seq: 0, strokes: [] };

const ID = /^[A-Za-z0-9_-]{8,64}$/;
// Printable text and line breaks only: no other control characters.
const TEXT = /^[^\u0000-\u0009\u000b-\u001f\u007f]+$/;

function point(raw: unknown): BoardPoint {
  if (!Array.isArray(raw) || raw.length !== 2) throw new WhiteboardError("invalid_command");
  const [x, y] = raw as unknown[];
  if (!Number.isInteger(x) || !Number.isInteger(y)) throw new WhiteboardError("invalid_command");
  if ((x as number) < 0 || (x as number) > BOARD.width || (y as number) < 0 || (y as number) > BOARD.maxHeight) throw new WhiteboardError("invalid_command");
  return [x as number, y as number];
}

// The one validation layer for a shape from the browser. The shape is
// rebuilt field by field; the author is the signed-in actor, never the body.
export function parseStroke(raw: unknown, authorId: string): Stroke {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new WhiteboardError("invalid_command");
  const input = raw as Record<string, unknown>;
  const id = typeof input.id === "string" && ID.test(input.id) ? input.id : null;
  const tool = input.tool === undefined ? "pen" : WHITEBOARD_TOOLS.find((item) => item === input.tool);
  const color = WHITEBOARD_COLORS.find((item) => item === input.color);
  const width = Number.isInteger(input.width) && (input.width as number) >= WHITEBOARD_LIMITS.minWidth && (input.width as number) <= WHITEBOARD_LIMITS.maxWidth ? (input.width as number) : null;
  if (!id || !tool || !color || !width || !Array.isArray(input.points)) throw new WhiteboardError("invalid_command");
  const count = input.points.length;
  const shapeOk = tool === "text" ? count === 1 : TWO_POINT_TOOLS.includes(tool) ? count === 2 : count >= 1 && count <= WHITEBOARD_LIMITS.maxPoints;
  if (!shapeOk) throw new WhiteboardError("invalid_command");
  const points = input.points.map(point);
  let text: string | undefined;
  if (tool === "text") {
    text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text || text.length > WHITEBOARD_LIMITS.maxTextLength || !TEXT.test(text)) throw new WhiteboardError("invalid_command");
  } else if (input.text !== undefined) {
    throw new WhiteboardError("invalid_command");
  }
  const stroke: Stroke = { id, authorId, tool, color, width, points, ...(text ? { text } : {}) };
  if (new TextEncoder().encode(JSON.stringify({ seq: 0, kind: "stroke", stroke })).length > WHITEBOARD_LIMITS.maxOpBytes) throw new WhiteboardError("invalid_command");
  return stroke;
}

// Applies one op to a board. The caller guarantees order (seq = board.seq + 1);
// replaying the same log always yields the same board.
export function applyOp(board: Board, op: BoardOp): Board {
  switch (op.kind) {
    case "stroke":
      return { seq: op.seq, strokes: [...board.strokes, op.stroke] };
    case "erase":
      return { seq: op.seq, strokes: board.strokes.filter((stroke) => stroke.id !== op.strokeId) };
    case "clear":
      return { seq: op.seq, strokes: [] };
  }
}

export function replay(ops: ReadonlyArray<BoardOp>, from: Board = EMPTY_BOARD): Board {
  return ops.reduce(applyOp, from);
}

// A browser's view of one log. Ops arrive by broadcast in any order and with
// gaps; an op is applied only when it is the next one. An older op is a
// duplicate and is dropped; a newer one means something was missed, so the
// caller reads the missing range from the server ("gap").
export function receiveOp(board: Board, op: BoardOp): { board: Board; gap: boolean } {
  if (op.seq <= board.seq) return { board, gap: false };
  if (op.seq !== board.seq + 1) return { board, gap: true };
  return { board: applyOp(board, op), gap: false };
}
