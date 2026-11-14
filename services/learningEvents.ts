import type { PoolClient } from "pg";
import { ensureSchema, getPool, query } from "@/services/persistence/db";

/**
 * Learning event domain (design §14 C8 + §12 learning-event contract).
 *
 * Learning time is a session event domain, not part of the content model:
 * - the client submits only eventId/sessionId/type/occurredAt/contentVersionId/
 *   stageKey/sequence; the server adds userId and the authoritative receivedAt;
 * - the ledger is append-only; eventId is the idempotency key;
 * - `completed` requires a prior `started` in the same
 *   (userId, sessionId, contentVersionId, stageKey);
 * - when the deployment has a plan projection, stageKey must belong to the
 *   frozen content version (unknown content version/stage is a 404, §14 C5 P7);
 *   a deployment without any projection (learning_plan_entries empty) records
 *   the event by contentVersionId with stageValidated=false instead (v1 scope:
 *   the projection writer is P1), never accepting a stage on trust;
 * - no content hash/digest is stored or used as identity/artifact binding: the
 *   eventId is the only identity and the as-run projection compares explicit
 *   fields only. The single hash call is a transient advisory-lock key (see
 *   withAppendTransaction); it is neither stored nor an identity.
 *
 * The as-run projection reconciles events against plan entries (C6/C8). v1
 * states are not-started / started / completed / out-of-order; reading the
 * plan from the content projection is the seam `LearningPlanSource`, whose
 * concrete reader below consumes the `learning_plan_entries` projection table.
 */

export const LEARNING_EVENT_TYPES = [
  "started",
  "paused",
  "resumed",
  "completed",
  "abandoned"
] as const;
export type LearningEventType = (typeof LEARNING_EVENT_TYPES)[number];

/** The client clock may lead the server by this much (skew tolerance). */
export const LEARNING_EVENT_CLOCK_SKEW_MS = 5 * 60_000;
/** Offline events older than this are refused ("离线补报超窗拒绝"). */
export const LEARNING_EVENT_BACKLOG_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** Client input: userId/receivedAt (server-authoritative fields) are not accepted. */
export type LearningEventInput = {
  eventId: string;
  sessionId: string;
  type: LearningEventType;
  /** ISO 8601 UTC (client clock), e.g. 2026-11-12T10:00:00.000Z. */
  occurredAt: string;
  contentVersionId: string;
  stageKey: string;
  sequence?: number;
};

/** Stored, append-only record. */
export type LearningEvent = LearningEventInput & {
  userId: string;
  /** Server clock; authoritative for duration and as-run ordering. */
  receivedAt: string;
};

/** Projection exposed to the caller: the server-owned userId is not echoed. */
export type PublicLearningEvent = Omit<LearningEvent, "userId"> & {
  /**
   * Whether stageKey was checked against the frozen plan projection. v1 scope:
   * a deployment with no plan projection (learning_plan_entries empty) records
   * the event by contentVersionId with stageValidated=false instead of 404 —
   * see the v1 scope note in `LearningPlanSource`.
   */
  stageValidated: boolean;
};

export type LearningEventErrorCode =
  | "INVALID_LEARNING_EVENT"
  | "OCCURRED_AT_OUT_OF_WINDOW"
  | "CONTENT_VERSION_NOT_FOUND"
  | "STAGE_NOT_FOUND"
  | "COMPLETED_WITHOUT_STARTED"
  | "EVENT_ID_CONFLICT";

export class LearningEventError extends Error {
  constructor(
    readonly code: LearningEventErrorCode,
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "LearningEventError";
  }
}

// Mirror of the frozen Part C contract (Admin contracts/primitives.ts and
// brands.ts): stable keys and ISO 8601 UTC instants. Only auditing times use
// occurredAt/receivedAt, and they never enter plan bytes (C6).
const STABLE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const INPUT_KEYS: ReadonlySet<string> = new Set([
  "eventId",
  "sessionId",
  "type",
  "occurredAt",
  "contentVersionId",
  "stageKey",
  "sequence"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStableKey(value: unknown): value is string {
  return typeof value === "string" && STABLE_KEY_PATTERN.test(value);
}

function invalid(message: string): LearningEventError {
  return new LearningEventError("INVALID_LEARNING_EVENT", 400, message);
}

/** Strict client-input parser: unknown keys (including server-owned fields) are rejected. */
export function parseLearningEventInput(value: unknown): LearningEventInput {
  if (!isRecord(value)) throw invalid("Learning event must be a JSON object.");
  for (const key of Object.keys(value)) {
    if (!INPUT_KEYS.has(key)) throw invalid(`Unknown learning event field: ${key}.`);
  }
  if (!isStableKey(value.eventId)) throw invalid("eventId must be a stable key (1-128 characters: letters, digits, '.', '_', '-').");
  if (!isStableKey(value.sessionId)) throw invalid("sessionId must be a stable key (1-128 characters: letters, digits, '.', '_', '-').");
  if (typeof value.type !== "string" || !(LEARNING_EVENT_TYPES as readonly string[]).includes(value.type)) {
    throw invalid(`type must be one of: ${LEARNING_EVENT_TYPES.join(", ")}.`);
  }
  if (typeof value.occurredAt !== "string" || !ISO_UTC_PATTERN.test(value.occurredAt) || Number.isNaN(Date.parse(value.occurredAt))) {
    throw invalid("occurredAt must be an ISO 8601 UTC timestamp ending in Z.");
  }
  if (!isStableKey(value.contentVersionId)) throw invalid("contentVersionId must be a stable key (1-128 characters: letters, digits, '.', '_', '-').");
  if (!isStableKey(value.stageKey)) throw invalid("stageKey must be a stable key (1-128 characters: letters, digits, '.', '_', '-').");
  if (value.sequence !== undefined && (typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence) || value.sequence < 0)) {
    throw invalid("sequence must be a non-negative integer when provided.");
  }
  return {
    eventId: value.eventId,
    sessionId: value.sessionId,
    type: value.type as LearningEventType,
    occurredAt: value.occurredAt,
    contentVersionId: value.contentVersionId,
    stageKey: value.stageKey,
    ...(value.sequence === undefined ? {} : { sequence: value.sequence })
  };
}

/**
 * occurredAt window: the server clock is authoritative. A client clock may
 * lead by the skew allowance; an offline replay may trail by the backlog
 * window. Anything else is refused (§12; C5 P7 "离线补报超窗拒绝").
 */
export function occurredAtWithinWindow(occurredAt: string, receivedAt: string): boolean {
  const occurred = Date.parse(occurredAt);
  const received = Date.parse(receivedAt);
  if (Number.isNaN(occurred) || Number.isNaN(received)) return false;
  return occurred >= received - LEARNING_EVENT_BACKLOG_WINDOW_MS
    && occurred <= received + LEARNING_EVENT_CLOCK_SKEW_MS;
}

// ---------------------------------------------------------------------------
// Plan projection seam (C8 as-run)
// ---------------------------------------------------------------------------

/** A frozen plan entry as far as as-run needs it (C3 PlanEntry, C6). */
export type LearningPlanEntry = {
  contentVersionId: string;
  entryId: string;
  stageKey: string;
  /** Canonical zero-padded numeric path segments (C3 orderKey). */
  orderKey: string;
};

/**
 * Plan-reading interface (the "plan 读取留接口" seam). The Portal consumes
 * published content versions through its projection.
 *
 * v1 scope (agreed with the Admin SSOT): writing the plan projection into
 * `learning_plan_entries` is P1 and has no producer yet. Until then:
 * - a deployment with a plan projection validates stageKey strictly (unknown
 *   content version / stage is 404, C5 P7);
 * - a deployment with no plan projection at all (`hasPlanProjection()` false,
 *   i.e. learning_plan_entries is empty) still records the event by
 *   contentVersionId but reports stageValidated=false. It never invents a plan
 *   and never claims a stage was validated.
 */
export interface LearningPlanSource {
  /** Entries for one frozen content version, or null when this deployment does not know it. */
  loadPlan(contentVersionId: string): Promise<readonly LearningPlanEntry[] | null>;
  /** Whether this deployment has any plan projection rows at all. */
  hasPlanProjection(): Promise<boolean>;
}

type PlanEntryRow = {
  content_version_id: string;
  entry_id: string;
  stage_key: string;
  order_key: string;
};

/** Reads the Portal's read-only projection of the frozen plan (learning_plan_entries). */
export function createPostgresLearningPlanSource(): LearningPlanSource {
  return {
    async loadPlan(contentVersionId) {
      const result = await query<PlanEntryRow>(
        `SELECT content_version_id, entry_id, stage_key, order_key
           FROM learning_plan_entries
          WHERE content_version_id = $1
          ORDER BY order_key ASC, entry_id ASC`,
        [contentVersionId]
      );
      if (result.rows.length === 0) return null;
      return result.rows.map((row) => ({
        contentVersionId: row.content_version_id,
        entryId: row.entry_id,
        stageKey: row.stage_key,
        orderKey: row.order_key
      }));
    },

    async hasPlanProjection() {
      const result = await query<{ projected: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM learning_plan_entries) AS projected`
      );
      return result.rows[0]?.projected === true;
    }
  };
}

// ---------------------------------------------------------------------------
// Event store
// ---------------------------------------------------------------------------

export type AppendOutcome =
  | { kind: "inserted"; event: LearningEvent }
  | { kind: "duplicate"; event: LearningEvent }
  | { kind: "completed_without_started" };

/**
 * Storage port. `append` is the only write: there is no update or delete path
 * (append-only, §14 C3). The `requireStarted` check and the insert happen in
 * one transaction so a concurrent start/complete pair cannot slip through.
 */
export interface LearningEventStore {
  findByEventId(eventId: string): Promise<LearningEvent | null>;
  append(event: LearningEvent, options: { requireStarted: boolean }): Promise<AppendOutcome>;
  listForContentVersion(userId: string, contentVersionId: string): Promise<LearningEvent[]>;
}

type LearningEventRow = {
  event_id: string;
  user_id: string;
  session_id: string;
  type: string;
  occurred_at: Date | string;
  received_at: Date | string;
  content_version_id: string;
  stage_key: string;
  sequence: number | string | null;
};

const EVENT_COLUMNS = `event_id, user_id, session_id, type, occurred_at, received_at,
       content_version_id, stage_key, sequence`;

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapEventRow(row: LearningEventRow): LearningEvent {
  return {
    eventId: row.event_id,
    userId: row.user_id,
    sessionId: row.session_id,
    type: row.type as LearningEventType,
    occurredAt: toIso(row.occurred_at),
    receivedAt: toIso(row.received_at),
    contentVersionId: row.content_version_id,
    stageKey: row.stage_key,
    ...(row.sequence === null ? {} : { sequence: Number(row.sequence) })
  };
}

function isRetryableTransactionError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "40001" || code === "40P01";
}

const TRANSACTION_ATTEMPTS = 3;

/**
 * One transaction per append. Appends in the same
 * (userId, sessionId, contentVersionId, stageKey) scope serialize on a
 * transaction-scoped advisory lock, so the completed-requires-started check
 * and the insert cannot interleave. The lock key is a serialization device
 * built from explicit fields; it is not an identity and nothing derived from
 * it is stored (the no-hash red line is about identity/artifact binding).
 */
function learningEventScopeKey(event: Pick<LearningEvent, "userId" | "sessionId" | "contentVersionId" | "stageKey">): string {
  return JSON.stringify([event.userId, event.sessionId, event.contentVersionId, event.stageKey]);
}

async function withAppendTransaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (!isRetryableTransactionError(error) || attempt >= TRANSACTION_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    } finally {
      client.release();
    }
  }
}

/** PostgreSQL store for the append-only ledger (Portal has no Prisma by design). */
export function createPostgresLearningEventStore(): LearningEventStore {
  return {
    async findByEventId(eventId) {
      const result = await query<LearningEventRow>(
        `SELECT ${EVENT_COLUMNS} FROM learning_events WHERE event_id = $1`,
        [eventId]
      );
      return result.rows[0] ? mapEventRow(result.rows[0]) : null;
    },

    async append(event, options) {
      await ensureSchema();
      return withAppendTransaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [learningEventScopeKey(event)]);
        const existing = await client.query<LearningEventRow>(
          `SELECT ${EVENT_COLUMNS} FROM learning_events WHERE event_id = $1`,
          [event.eventId]
        );
        if (existing.rows[0]) return { kind: "duplicate", event: mapEventRow(existing.rows[0]) };

        if (options.requireStarted) {
          const started = await client.query(
            `SELECT 1 FROM learning_events
              WHERE user_id = $1 AND session_id = $2 AND content_version_id = $3
                AND stage_key = $4 AND type = 'started'
              LIMIT 1`,
            [event.userId, event.sessionId, event.contentVersionId, event.stageKey]
          );
          if (started.rowCount === 0) return { kind: "completed_without_started" };
        }

        const inserted = await client.query<LearningEventRow>(
          `INSERT INTO learning_events
             (event_id, user_id, session_id, type, occurred_at, received_at,
              content_version_id, stage_key, sequence)
           VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, $8, $9)
           ON CONFLICT (event_id) DO NOTHING
           RETURNING ${EVENT_COLUMNS}`,
          [
            event.eventId,
            event.userId,
            event.sessionId,
            event.type,
            event.occurredAt,
            event.receivedAt,
            event.contentVersionId,
            event.stageKey,
            event.sequence ?? null
          ]
        );
        if (inserted.rows[0]) return { kind: "inserted", event: mapEventRow(inserted.rows[0]) };

        const raced = await client.query<LearningEventRow>(
          `SELECT ${EVENT_COLUMNS} FROM learning_events WHERE event_id = $1`,
          [event.eventId]
        );
        // ON CONFLICT without RETURNING means another transaction stored the
        // same eventId between our read and the insert; it must be visible now.
        return { kind: "duplicate", event: mapEventRow(raced.rows[0]) };
      });
    },

    async listForContentVersion(userId, contentVersionId) {
      const result = await query<LearningEventRow>(
        `SELECT ${EVENT_COLUMNS}
           FROM learning_events
          WHERE user_id = $1 AND content_version_id = $2
          ORDER BY received_at ASC, event_id ASC`,
        [userId, contentVersionId]
      );
      return result.rows.map(mapEventRow);
    }
  };
}

// ---------------------------------------------------------------------------
// as-run projection (events × plan entries)
// ---------------------------------------------------------------------------

export type AsRunState = "not-started" | "started" | "completed" | "out-of-order";

export type AsRunEntry = {
  entryId: string;
  stageKey: string;
  orderKey: string;
  state: AsRunState;
  eventCount: number;
  /** Earliest client occurredAt among `started` events; null when none. */
  firstStartedAt: string | null;
  /** Earliest client occurredAt among `completed` events; null when none. */
  completedAt: string | null;
  /**
   * Events whose server-received order contradicts their declared
   * `sequence`, plus a `completed` received before any `started` for the stage.
   */
  outOfOrderEventIds: string[];
};

function compareEvents(left: LearningEvent, right: LearningEvent): number {
  return left.receivedAt.localeCompare(right.receivedAt)
    || left.occurredAt.localeCompare(right.occurredAt)
    || left.eventId.localeCompare(right.eventId);
}

/**
 * v1 as-run reconciliation (C6/C8): one state per plan entry, keyed by
 * contentVersionId + stageKey. It is a trajectory, never written back to Plan.
 *
 * - not-started: the stage has no events for this content version;
 * - started: events exist, no completed;
 * - completed: a completed event exists;
 * - out-of-order: a later-received event carries a smaller `sequence` than the
 *   maximum already received for its session, or a `completed` is received
 *   before any `started` for its stage. This surfaces event-order anomalies
 *   without trusting the client clock.
 *
 * Events for other content versions are ignored (cross-version statistics do
 * not mix, LongRange T7).
 */
export function projectAsRun(input: {
  contentVersionId: string;
  events: readonly LearningEvent[];
  planEntries: readonly LearningPlanEntry[];
}): AsRunEntry[] {
  const events = input.events
    .filter((event) => event.contentVersionId === input.contentVersionId)
    .sort(compareEvents);

  const sequenceAnomalies = new Set<string>();
  const maxSequenceBySession = new Map<string, number>();
  for (const event of events) {
    if (event.sequence === undefined) continue;
    const previous = maxSequenceBySession.get(event.sessionId);
    if (previous !== undefined && event.sequence < previous) sequenceAnomalies.add(event.eventId);
    maxSequenceBySession.set(event.sessionId, previous === undefined ? event.sequence : Math.max(previous, event.sequence));
  }

  const entries = input.planEntries
    .filter((entry) => entry.contentVersionId === input.contentVersionId)
    .sort((left, right) => left.orderKey.localeCompare(right.orderKey) || left.entryId.localeCompare(right.entryId));

  return entries.map((entry) => {
    const stageEvents = events.filter((event) => event.stageKey === entry.stageKey);
    const outOfOrder = new Set<string>();
    let startedSeen = false;
    for (const event of stageEvents) {
      if (sequenceAnomalies.has(event.eventId)) outOfOrder.add(event.eventId);
      if (event.type === "started") startedSeen = true;
      if (event.type === "completed" && !startedSeen) outOfOrder.add(event.eventId);
    }

    const started = stageEvents.filter((event) => event.type === "started").map((event) => event.occurredAt).sort();
    const completed = stageEvents.filter((event) => event.type === "completed").map((event) => event.occurredAt).sort();
    const state: AsRunState = stageEvents.length === 0
      ? "not-started"
      : outOfOrder.size > 0
        ? "out-of-order"
        : completed.length > 0
          ? "completed"
          : "started";

    return {
      entryId: entry.entryId,
      stageKey: entry.stageKey,
      orderKey: entry.orderKey,
      state,
      eventCount: stageEvents.length,
      firstStartedAt: started[0] ?? null,
      completedAt: completed[0] ?? null,
      outOfOrderEventIds: [...outOfOrder].sort()
    };
  });
}

// ---------------------------------------------------------------------------
// Application service
// ---------------------------------------------------------------------------

export type LearningEventsService = {
  appendEvent(
    userId: string,
    input: unknown
  ): Promise<{ event: LearningEvent; duplicate: boolean; stageValidated: boolean }>;
  getAsRun(userId: string, contentVersionId: string): Promise<AsRunEntry[]>;
};

export type LearningEventsServiceDeps = {
  store: LearningEventStore;
  planSource: LearningPlanSource;
  /** Server clock override for tests; production uses the real clock. */
  now?: () => Date;
};

export function createLearningEventsService(deps: LearningEventsServiceDeps): LearningEventsService {
  const now = deps.now ?? (() => new Date());

  function stageValidatedIn(
    plan: readonly LearningPlanEntry[] | null,
    stageKey: string
  ): boolean {
    return plan !== null && plan.some((entry) => entry.stageKey === stageKey);
  }

  return {
    async appendEvent(userId, rawInput) {
      if (!userId) throw new LearningEventError("INVALID_LEARNING_EVENT", 400, "A signed-in user is required.");
      const input = parseLearningEventInput(rawInput);

      // Idempotency first: replaying an accepted event must succeed even if it
      // would now fall outside the clock window. Never echo another user's row.
      const existing = await deps.store.findByEventId(input.eventId);
      if (existing) {
        if (existing.userId !== userId) {
          throw new LearningEventError("EVENT_ID_CONFLICT", 409, "eventId is already in use.");
        }
        // A replay is never re-validated (it was accepted); report whether the
        // stage matches a plan this deployment knows, without refusing the replay.
        const replayPlan = await deps.planSource.loadPlan(input.contentVersionId);
        return {
          event: existing,
          duplicate: true,
          stageValidated: stageValidatedIn(replayPlan, input.stageKey)
        };
      }

      const receivedAt = now().toISOString();
      if (!occurredAtWithinWindow(input.occurredAt, receivedAt)) {
        throw new LearningEventError(
          "OCCURRED_AT_OUT_OF_WINDOW",
          400,
          "occurredAt is outside the accepted window relative to the server clock."
        );
      }

      // v1 scope: with a plan projection, stageKey must belong to the frozen
      // content version (unknown version/stage -> 404). Without any projection
      // (P1 writer not wired), the event is recorded by contentVersionId with
      // stageValidated=false — we must not 404 the whole domain or trust a stage.
      const plan = await deps.planSource.loadPlan(input.contentVersionId);
      if (plan === null && (await deps.planSource.hasPlanProjection())) {
        throw new LearningEventError("CONTENT_VERSION_NOT_FOUND", 404, "Unknown content version.");
      }
      const stageValidated = stageValidatedIn(plan, input.stageKey);
      if (plan !== null && !stageValidated) {
        throw new LearningEventError("STAGE_NOT_FOUND", 404, "stageKey does not belong to this content version.");
      }

      const event: LearningEvent = { ...input, userId, receivedAt };
      const outcome = await deps.store.append(event, { requireStarted: input.type === "completed" });
      if (outcome.kind === "completed_without_started") {
        throw new LearningEventError("COMPLETED_WITHOUT_STARTED", 409, "A completed event requires a prior started event for the same session and stage.");
      }
      if (outcome.kind === "duplicate" && outcome.event.userId !== userId) {
        throw new LearningEventError("EVENT_ID_CONFLICT", 409, "eventId is already in use.");
      }
      return { event: outcome.event, duplicate: outcome.kind === "duplicate", stageValidated };
    },

    async getAsRun(userId, contentVersionId) {
      const plan = await deps.planSource.loadPlan(contentVersionId);
      if (!plan) throw new LearningEventError("CONTENT_VERSION_NOT_FOUND", 404, "Unknown content version.");
      const events = await deps.store.listForContentVersion(userId, contentVersionId);
      return projectAsRun({ contentVersionId, events, planEntries: plan });
    }
  };
}

/** Response shape for the event API: append the server receivedAt, omit userId. */
export function publicLearningEvent(event: LearningEvent, stageValidated: boolean): PublicLearningEvent {
  return {
    eventId: event.eventId,
    sessionId: event.sessionId,
    type: event.type,
    occurredAt: event.occurredAt,
    contentVersionId: event.contentVersionId,
    stageKey: event.stageKey,
    ...(event.sequence === undefined ? {} : { sequence: event.sequence }),
    receivedAt: event.receivedAt,
    stageValidated
  };
}
