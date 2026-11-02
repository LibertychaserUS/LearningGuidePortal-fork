import { parseStroke, replay, WhiteboardError, WHITEBOARD_LIMITS, type BoardOp, type BoardOpInput } from "./domain";
import { applyStageCommand, audience, boardKey, canDraw, canSee, initialStage, parseBoardKey, parseStageCommand, type PresentationRef, type Role, type Stage } from "./stage";
import type { WhiteboardMessage } from "./wire";

// Ports. The prototype ships an in-memory store; production keeps the same
// interface on PostgreSQL: one stage row per session (version column for the
// compare-and-set), one row per op with primary key (session, board, seq) and
// a unique key (session, board, stroke id) so a retried stroke is stored once.
// The permission check and the append then run in one transaction.
export interface WhiteboardStore {
  readStage(sessionId: string): Promise<Stage | null>;
  // Writes `next` only while the stored version is still `expectedVersion`
  // (-1 = no stage yet).
  writeStage(sessionId: string, expectedVersion: number, next: Stage): Promise<boolean>;
  // Appends `op` as seq = current + 1. A stroke whose id is already in this
  // board is not appended again; the stored op comes back with duplicate.
  append(sessionId: string, board: string, op: BoardOpInput): Promise<{ op: BoardOp; duplicate: boolean }>;
  // Ops with seq > `after`, in order.
  opsAfter(sessionId: string, board: string, after: number): Promise<BoardOp[]>;
}

// The session's people, read from the Study Group service.
export type WhiteboardRoster = (sessionId: string) => Promise<{ hostIds: string[]; memberIds: string[] }>;

// The only path to the room. A failed broadcast never fails the write:
// browsers repair what they missed from the stage and the logs.
export type WhiteboardBroadcaster = (input: { sessionId: string; message: WhiteboardMessage; destinationIdentities?: string[] }) => Promise<void>;

// A ready presentation of the session, for the "present" command
// (presentationService.ts ref).
export type WhiteboardPresentations = (sessionId: string, presentationId: string) => Promise<PresentationRef | null>;

export function createWhiteboardService(deps: { store: WhiteboardStore; roster: WhiteboardRoster; broadcast: WhiteboardBroadcaster; presentations?: WhiteboardPresentations }) {
  async function role(sessionId: string, userId: string): Promise<{ role: Role; hostIds: string[]; memberIds: string[] }> {
    const roster = await deps.roster(sessionId);
    if (roster.hostIds.includes(userId)) return { role: "host", ...roster };
    if (roster.memberIds.includes(userId)) return { role: "member", ...roster };
    throw new WhiteboardError("forbidden");
  }

  async function stage(sessionId: string) {
    const stored = await deps.store.readStage(sessionId);
    if (!stored) throw new WhiteboardError("not_found");
    return stored;
  }

  async function send(sessionId: string, message: WhiteboardMessage, destinationIdentities?: string[]) {
    try {
      await deps.broadcast({ sessionId, message, ...(destinationIdentities ? { destinationIdentities } : {}) });
    } catch {
      console.info(JSON.stringify({ type: "whiteboard.broadcast_failed", kind: message.kind }));
    }
  }

  async function commit(sessionId: string, current: Stage, hostIds: string[], board: string, input: BoardOpInput) {
    const { op, duplicate } = await deps.store.append(sessionId, board, input);
    if (!duplicate) await send(sessionId, { kind: "op", board, op }, audience(current, parseBoardKey(board), hostIds));
    return op;
  }

  return {
    // Idempotent: the host opening the board twice gets the same stage.
    async open(input: { actorUserId: string; sessionId: string }) {
      if ((await role(input.sessionId, input.actorUserId)).role !== "host") throw new WhiteboardError("forbidden");
      const existing = await deps.store.readStage(input.sessionId);
      if (existing) return existing;
      await deps.store.writeStage(input.sessionId, -1, initialStage(input.sessionId));
      const opened = await stage(input.sessionId);
      await send(input.sessionId, { kind: "stage", stage: opened });
      return opened;
    },

    async stage(input: { actorUserId: string; sessionId: string }) {
      const actor = await role(input.sessionId, input.actorUserId);
      return { role: actor.role, stage: await stage(input.sessionId) };
    },

    async command(input: { actorUserId: string; sessionId: string; command: unknown }) {
      const actor = await role(input.sessionId, input.actorUserId);
      if (actor.role !== "host") throw new WhiteboardError("forbidden");
      const command = parseStageCommand(input.command);
      const presentation = command.type === "present" && deps.presentations ? await deps.presentations(input.sessionId, command.presentationId) : null;
      // One retry on a version race between two host tabs; a second loss is
      // reported, not hidden.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const current = await stage(input.sessionId);
        const next = applyStageCommand(current, command, actor.memberIds, presentation);
        if (!next) return current;
        if (await deps.store.writeStage(input.sessionId, current.version, next)) {
          await send(input.sessionId, { kind: "stage", stage: next });
          return next;
        }
      }
      throw new WhiteboardError("version_conflict");
    },

    // Join, resync and opening a newly visible board: everything after `after`.
    async ops(input: { actorUserId: string; sessionId: string; board: unknown; after: number }) {
      const actor = await role(input.sessionId, input.actorUserId);
      const board = parseBoardKey(input.board);
      if (!canSee(await stage(input.sessionId), actor.role, input.actorUserId, board)) throw new WhiteboardError("forbidden");
      const after = Number.isInteger(input.after) && input.after >= 0 ? input.after : 0;
      return deps.store.opsAfter(input.sessionId, boardKey(board), after);
    },

    async draw(input: { actorUserId: string; sessionId: string; board: unknown; stroke: unknown }) {
      const actor = await role(input.sessionId, input.actorUserId);
      const board = parseBoardKey(input.board);
      const current = await stage(input.sessionId);
      if (board.owner !== "main" && !actor.memberIds.includes(board.owner)) throw new WhiteboardError("not_found");
      if (!canDraw(current, actor.role, input.actorUserId, board)) throw new WhiteboardError("forbidden");
      const stroke = parseStroke(input.stroke, input.actorUserId);
      const key = boardKey(board);
      if (replay(await deps.store.opsAfter(input.sessionId, key, 0)).strokes.length >= WHITEBOARD_LIMITS.maxStrokes) throw new WhiteboardError("board_full");
      return commit(input.sessionId, current, actor.hostIds, key, { kind: "stroke", stroke });
    },

    // Members erase their own strokes where they may draw; the host any.
    async erase(input: { actorUserId: string; sessionId: string; board: unknown; strokeId: string }) {
      const actor = await role(input.sessionId, input.actorUserId);
      const board = parseBoardKey(input.board);
      const current = await stage(input.sessionId);
      const key = boardKey(board);
      const stroke = replay(await deps.store.opsAfter(input.sessionId, key, 0)).strokes.find((item) => item.id === input.strokeId);
      if (!stroke) throw new WhiteboardError("not_found");
      if (actor.role !== "host" && (stroke.authorId !== input.actorUserId || !canDraw(current, actor.role, input.actorUserId, board))) throw new WhiteboardError("forbidden");
      return commit(input.sessionId, current, actor.hostIds, key, { kind: "erase", strokeId: stroke.id, byId: input.actorUserId });
    },

    // The host clears any board; a member clears their own board.
    async clear(input: { actorUserId: string; sessionId: string; board: unknown }) {
      const actor = await role(input.sessionId, input.actorUserId);
      const board = parseBoardKey(input.board);
      const current = await stage(input.sessionId);
      if (actor.role !== "host" && !(board.owner === input.actorUserId && canDraw(current, actor.role, input.actorUserId, board))) throw new WhiteboardError("forbidden");
      const key = boardKey(board);
      if (replay(await deps.store.opsAfter(input.sessionId, key, 0)).strokes.length === 0) return null;
      return commit(input.sessionId, current, actor.hostIds, key, { kind: "clear", byId: input.actorUserId });
    }
  };
}

export type WhiteboardService = ReturnType<typeof createWhiteboardService>;

export function createMemoryWhiteboardStore(): WhiteboardStore {
  const stages = new Map<string, Stage>();
  const logs = new Map<string, BoardOp[]>();
  const logKey = (sessionId: string, board: string) => `${sessionId}\u0000${board}`;
  return {
    async readStage(sessionId) {
      return stages.get(sessionId) ?? null;
    },
    async writeStage(sessionId, expectedVersion, next) {
      if ((stages.get(sessionId)?.version ?? -1) !== expectedVersion) return false;
      stages.set(sessionId, next);
      return true;
    },
    async append(sessionId, board, input) {
      const key = logKey(sessionId, board);
      const log = logs.get(key) ?? [];
      if (input.kind === "stroke") {
        const stored = log.find((op) => op.kind === "stroke" && op.stroke.id === input.stroke.id);
        if (stored) return { op: stored, duplicate: true };
      }
      const op = { ...input, seq: log.length + 1 } as BoardOp;
      logs.set(key, [...log, op]);
      return { op, duplicate: false };
    },
    async opsAfter(sessionId, board, after) {
      return (logs.get(logKey(sessionId, board)) ?? []).filter((op) => op.seq > after);
    }
  };
}
