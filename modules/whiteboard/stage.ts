// The classroom around the boards: which courseware is up, what everyone is
// looking at and who may draw where. The host (BigBlueButton's
// presenter) runs it; the server stores it as one versioned record and
// broadcasts the whole record on every change, so a browser never applies
// deltas and only compares versions.
//
// Boards, one op log each, keyed per courseware page:
//  - "main/<presentation>/<page>": the page everyone sees. The host draws; a
//    member draws while holding the pen, or while the multi-user whiteboard is
//    on.
//  - "member:<userId>/<presentation>/<page>": that member's own copy of the
//    page, used in "work" mode. The owner draws on it; the host sees every
//    member's copy and may annotate it. Other members see it only while the
//    host spotlights it.
//
// Pure: no I/O, no clock, no LiveKit.

import { WhiteboardError } from "./domain";

export const STAGE_LIMITS = { maxPages: 200, maxPens: 6, maxScale: 4 } as const;

// The empty whiteboard every session starts on (BigBlueButton's default
// presentation): one blank 16:9 page.
export const BLANK_PRESENTATION = { id: "blank", name: "", pageCount: 1 } as const;

export type PresentationRef = Readonly<{ id: string; name: string; pageCount: number }>;

// What the room is shown. "full" spotlights one member's board enlarged;
// "split" shows it beside the main board.
export type StageView = Readonly<{ kind: "main" } | { kind: "spotlight"; userId: string; size: "full" | "split" }>;

// The presenter's zoom, followed by everyone (as in BigBlueButton): `scale`
// 1..4 and the visible window's top-left corner as a fraction of the page.
export type Viewport = Readonly<{ scale: number; x: number; y: number }>;

export const FIT_VIEWPORT: Viewport = { scale: 1, x: 0, y: 0 };

export type Stage = Readonly<{
  sessionId: string;
  version: number;
  presentation: PresentationRef;
  page: number;
  viewport: Viewport;
  view: StageView;
  // Members given the pen one by one ("Give whiteboard access").
  pens: ReadonlyArray<string>;
  // "Multi-user whiteboard": every member may draw on the main board.
  everyone: boolean;
  // Every member works on their own copy of the current page.
  work: boolean;
  // Freezes all member drawing (main and own boards) at once.
  locked: boolean;
}>;

export type StageCommand =
  | { type: "present"; presentationId: string }
  | { type: "goto"; page: number }
  | { type: "zoom"; viewport: Viewport }
  | { type: "spotlight"; userId: string; size: "full" | "split" }
  | { type: "end_spotlight" }
  | { type: "grant_pen"; userId: string }
  | { type: "revoke_pen"; userId: string }
  | { type: "everyone"; on: boolean }
  | { type: "work"; on: boolean }
  | { type: "lock"; on: boolean };

export type Role = "host" | "member";

export type BoardRef = Readonly<{ owner: "main" | string; presentation: string; page: number }>;

const USER = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,63}$/;
export const PRESENTATION_ID = /^[A-Za-z0-9_-]{5,40}$/;

export function initialStage(sessionId: string): Stage {
  return { sessionId, version: 0, presentation: BLANK_PRESENTATION, page: 0, viewport: FIT_VIEWPORT, view: { kind: "main" }, pens: [], everyone: false, work: false, locked: false };
}

export function boardKey(board: BoardRef) {
  return `${board.owner === "main" ? "main" : `member:${board.owner}`}/${board.presentation}/${board.page}`;
}

export function parseBoardKey(key: unknown): BoardRef {
  if (typeof key !== "string") throw new WhiteboardError("invalid_command");
  const match = /^(?:main|member:([A-Za-z0-9][A-Za-z0-9_.:@-]{0,63}))\/([A-Za-z0-9_-]{5,40})\/(\d{1,3})$/.exec(key);
  if (!match) throw new WhiteboardError("invalid_command");
  return { owner: match[1] ?? "main", presentation: match[2], page: Number(match[3]) };
}

function fraction(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 10_000) / 10_000 : NaN;
}

// The one validation layer for host input: the shape is rebuilt field by field.
export function parseStageCommand(raw: unknown): StageCommand {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new WhiteboardError("invalid_command");
  const command = raw as Record<string, unknown>;
  const user = typeof command.userId === "string" && USER.test(command.userId) ? command.userId : null;
  switch (command.type) {
    case "present":
      if (typeof command.presentationId !== "string" || !PRESENTATION_ID.test(command.presentationId)) throw new WhiteboardError("invalid_command");
      return { type: "present", presentationId: command.presentationId };
    case "goto":
      if (!Number.isInteger(command.page)) throw new WhiteboardError("invalid_command");
      return { type: "goto", page: command.page as number };
    case "zoom": {
      const viewport = command.viewport as Record<string, unknown> | undefined;
      const scale = fraction(viewport?.scale), x = fraction(viewport?.x), y = fraction(viewport?.y);
      if (!(scale >= 1 && scale <= STAGE_LIMITS.maxScale)) throw new WhiteboardError("invalid_command");
      // The window stays on the page: its corner moves at most 1 - 1/scale.
      const room = 1 - 1 / scale + 1e-4;
      if (!(x >= 0 && x <= room && y >= 0 && y <= room)) throw new WhiteboardError("invalid_command");
      return { type: "zoom", viewport: { scale, x, y } };
    }
    case "spotlight":
      if (!user || (command.size !== "full" && command.size !== "split")) throw new WhiteboardError("invalid_command");
      return { type: "spotlight", userId: user, size: command.size };
    case "end_spotlight":
      return { type: "end_spotlight" };
    case "grant_pen":
    case "revoke_pen":
      if (!user) throw new WhiteboardError("invalid_command");
      return { type: command.type, userId: user };
    case "everyone":
    case "work":
    case "lock":
      if (typeof command.on !== "boolean") throw new WhiteboardError("invalid_command");
      return { type: command.type, on: command.on };
    default:
      throw new WhiteboardError("invalid_command");
  }
}

// Applies one validated host command. `members` are the session's member
// ids, so a spotlight or pen can only name someone in the room; `presentation`
// is the courseware a "present" command names, as the server found it (ready
// and in this session), or null. Returns null when nothing changes, so a
// repeated click neither bumps the version nor broadcasts.
export function applyStageCommand(stage: Stage, command: StageCommand, members: ReadonlyArray<string>, presentation: PresentationRef | null = null): Stage | null {
  const next = (patch: Partial<Stage>): Stage => ({ ...stage, ...patch, version: stage.version + 1 });
  switch (command.type) {
    case "present":
      if (command.presentationId === stage.presentation.id) return null;
      if (command.presentationId === BLANK_PRESENTATION.id) presentation = BLANK_PRESENTATION;
      if (!presentation || presentation.id !== command.presentationId) throw new WhiteboardError("not_found");
      if (!Number.isInteger(presentation.pageCount) || presentation.pageCount < 1 || presentation.pageCount > STAGE_LIMITS.maxPages) throw new WhiteboardError("invalid_command");
      // A new deck starts on its first page, unzoomed, with the room back on
      // the main board.
      return next({ presentation, page: 0, viewport: FIT_VIEWPORT, view: { kind: "main" } });
    case "goto":
      if (command.page < 0 || command.page >= stage.presentation.pageCount) throw new WhiteboardError("invalid_command");
      return command.page === stage.page ? null : next({ page: command.page, viewport: FIT_VIEWPORT });
    case "zoom": {
      const { scale, x, y } = command.viewport;
      if (scale === stage.viewport.scale && x === stage.viewport.x && y === stage.viewport.y) return null;
      return next({ viewport: scale === 1 ? FIT_VIEWPORT : command.viewport });
    }
    case "spotlight":
      if (!members.includes(command.userId)) throw new WhiteboardError("not_found");
      if (stage.view.kind === "spotlight" && stage.view.userId === command.userId && stage.view.size === command.size) return null;
      return next({ view: { kind: "spotlight", userId: command.userId, size: command.size } });
    case "end_spotlight":
      return stage.view.kind === "main" ? null : next({ view: { kind: "main" } });
    case "grant_pen":
      if (!members.includes(command.userId)) throw new WhiteboardError("not_found");
      if (stage.pens.includes(command.userId)) return null;
      if (stage.pens.length >= STAGE_LIMITS.maxPens) throw new WhiteboardError("invalid_command");
      return next({ pens: [...stage.pens, command.userId] });
    case "revoke_pen":
      return stage.pens.includes(command.userId) ? next({ pens: stage.pens.filter((id) => id !== command.userId) }) : null;
    case "everyone":
      return stage.everyone === command.on ? null : next({ everyone: command.on });
    case "work":
      return stage.work === command.on ? null : next({ work: command.on });
    case "lock":
      return stage.locked === command.on ? null : next({ locked: command.on });
  }
}

function spotlighted(stage: Stage, owner: string) {
  return stage.view.kind === "spotlight" && stage.view.userId === owner;
}

// Who may read a board's log (and so receive its ops).
export function canSee(stage: Stage, role: Role, actorId: string, board: BoardRef) {
  if (role === "host" || board.owner === "main") return true;
  return board.owner === actorId || spotlighted(stage, board.owner);
}

// Who may add a shape to a board, or erase their own shapes on it. Everyone,
// the host included, draws on the courseware that is up; members only on the
// current page and never while locked.
export function canDraw(stage: Stage, role: Role, actorId: string, board: BoardRef) {
  if (board.presentation !== stage.presentation.id || board.page >= stage.presentation.pageCount) return false;
  if (role === "host") return true;
  if (stage.locked || board.page !== stage.page) return false;
  if (board.owner === "main") return stage.everyone || stage.pens.includes(actorId);
  return board.owner === actorId && stage.work;
}

// The LiveKit destinations for an op on `board`: undefined means the whole
// room. A member's own board goes to that member and the hosts only, unless
// it is spotlighted.
export function audience(stage: Stage, board: BoardRef, hostIds: ReadonlyArray<string>): string[] | undefined {
  if (board.owner === "main" || spotlighted(stage, board.owner)) return undefined;
  return [...new Set([board.owner, ...hostIds])];
}
