import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createLearningEventsService,
  LearningEventError,
  LEARNING_EVENT_BACKLOG_WINDOW_MS,
  LEARNING_EVENT_CLOCK_SKEW_MS,
  projectAsRun,
  type AppendOutcome,
  type LearningEvent,
  type LearningEventInput,
  type LearningEventStore,
  type LearningPlanEntry,
  type LearningPlanSource
} from "../../services/learningEvents";

/**
 * Unit proofs for the Portal learning-event domain (§14 C8 / §12):
 * idempotency, the server-authoritative clock, completion ordering, stage
 * membership and the four v1 as-run states.
 *
 * v1 scope for stage validation: a deployment that has a plan projection
 * refuses unknown content versions/stages (404); a deployment with no plan
 * projection at all (learning_plan_entries empty, writer is P1) records the
 * event by contentVersionId with stageValidated=false instead. The store is an
 * in-memory port so the tests prove the service contract without a database;
 * the PostgreSQL store speaks the same port and is exercised by the long-range
 * T7 test.
 */

const SERVER_NOW = "2026-11-12T10:00:00.000Z";
const CONTENT_VERSION = "cv-01";

const PLAN: LearningPlanEntry[] = [
  { contentVersionId: CONTENT_VERSION, entryId: "entry:step-01:aln-1:occ-1", stageKey: "step-01", orderKey: "001" },
  { contentVersionId: CONTENT_VERSION, entryId: "entry:step-02:aln-2:occ-1", stageKey: "step-02", orderKey: "002" },
  { contentVersionId: CONTENT_VERSION, entryId: "entry:step-03:aln-3:occ-1", stageKey: "step-03", orderKey: "003" }
];

type MemoryStore = LearningEventStore & { rows: Map<string, LearningEvent> };

function memoryStore(): MemoryStore {
  const rows = new Map<string, LearningEvent>();
  return {
    rows,
    async findByEventId(eventId) {
      return rows.get(eventId) ?? null;
    },
    async append(event, options): Promise<AppendOutcome> {
      const existing = rows.get(event.eventId);
      if (existing) return { kind: "duplicate", event: existing };
      if (options.requireStarted) {
        const started = [...rows.values()].some((row) =>
          row.userId === event.userId
          && row.sessionId === event.sessionId
          && row.contentVersionId === event.contentVersionId
          && row.stageKey === event.stageKey
          && row.type === "started");
        if (!started) return { kind: "completed_without_started" };
      }
      rows.set(event.eventId, event);
      return { kind: "inserted", event };
    },
    async listForContentVersion(userId, contentVersionId) {
      return [...rows.values()]
        .filter((row) => row.userId === userId && row.contentVersionId === contentVersionId)
        .sort((left, right) => left.receivedAt.localeCompare(right.receivedAt) || left.eventId.localeCompare(right.eventId));
    }
  };
}

function planSource(plans: Record<string, LearningPlanEntry[]> = { [CONTENT_VERSION]: PLAN }): LearningPlanSource {
  return {
    async loadPlan(contentVersionId) {
      return plans[contentVersionId] ?? null;
    },
    async hasPlanProjection() {
      // An empty map models a deployment where the projection writer (P1) has
      // not been wired yet: no content version is projected.
      return Object.keys(plans).length > 0;
    }
  };
}

let eventCounter = 0;
function input(overrides: Partial<LearningEventInput> = {}): LearningEventInput {
  eventCounter += 1;
  return {
    eventId: `evt-${eventCounter}`,
    sessionId: "sess-01",
    type: "started",
    occurredAt: "2026-11-12T09:59:00.000Z",
    contentVersionId: CONTENT_VERSION,
    stageKey: "step-01",
    ...overrides
  };
}

function service(options: { store?: MemoryStore; plans?: Record<string, LearningPlanEntry[]>; now?: string } = {}) {
  const store = options.store ?? memoryStore();
  const svc = createLearningEventsService({
    store,
    planSource: planSource(options.plans),
    now: () => new Date(options.now ?? SERVER_NOW)
  });
  return { store, svc };
}

async function expectEventError(promise: Promise<unknown>, code: string, status: number) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof LearningEventError, `expected LearningEventError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Clock and input authority
// ---------------------------------------------------------------------------

test("the server stamps receivedAt; client userId/receivedAt/elapsed fields are rejected", async () => {
  const { store, svc } = service();
  const result = await svc.appendEvent("user-01", input());
  assert.equal(result.duplicate, false);
  assert.equal(result.event.userId, "user-01");
  assert.equal(result.event.receivedAt, SERVER_NOW, "receivedAt is the server clock");
  assert.equal(result.event.occurredAt, "2026-11-12T09:59:00.000Z", "occurredAt stays the client clock");

  for (const forbidden of [
    { userId: "user-02" },
    { receivedAt: SERVER_NOW },
    { elapsedSeconds: 42 }
  ]) {
    await expectEventError(svc.appendEvent("user-01", { ...input(), ...forbidden }), "INVALID_LEARNING_EVENT", 400);
  }
  assert.equal(store.rows.size, 1, "rejected bodies are never stored");
});

test("occurredAt is bounded by the server clock: forward skew and offline backlog", async () => {
  const { svc } = service();
  const nowMs = Date.parse(SERVER_NOW);
  const at = (ms: number) => new Date(ms).toISOString();

  // Boundary values are accepted (inclusive).
  await svc.appendEvent("user-01", input({ eventId: "evt-skew-edge", occurredAt: at(nowMs + LEARNING_EVENT_CLOCK_SKEW_MS) }));
  await svc.appendEvent("user-01", input({ eventId: "evt-backlog-edge", occurredAt: at(nowMs - LEARNING_EVENT_BACKLOG_WINDOW_MS) }));

  // One millisecond beyond either boundary is refused.
  await expectEventError(
    svc.appendEvent("user-01", input({ eventId: "evt-skew-over", occurredAt: at(nowMs + LEARNING_EVENT_CLOCK_SKEW_MS + 1) })),
    "OCCURRED_AT_OUT_OF_WINDOW",
    400
  );
  await expectEventError(
    svc.appendEvent("user-01", input({ eventId: "evt-backlog-over", occurredAt: at(nowMs - LEARNING_EVENT_BACKLOG_WINDOW_MS - 1) })),
    "OCCURRED_AT_OUT_OF_WINDOW",
    400
  );

  // Only ISO 8601 UTC instants are accepted.
  for (const occurredAt of [
    "2026-11-12T10:00:00",
    "2026-11-12T10:00:00+00:00",
    "2026-11-12T10:00:00.1234Z",
    "2026-13-01T10:00:00Z",
    "not-a-time"
  ]) {
    await expectEventError(svc.appendEvent("user-01", input({ occurredAt })), "INVALID_LEARNING_EVENT", 400);
  }
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test("a repeated eventId is idempotent and never inserts twice", async () => {
  const { store, svc } = service();
  const first = input({ eventId: "evt-idempotent" });
  const created = await svc.appendEvent("user-01", first);

  const replay = await svc.appendEvent("user-01", { ...first, type: "paused", occurredAt: "2026-11-12T09:00:00.000Z" });
  assert.equal(replay.duplicate, true);
  assert.deepEqual(replay.event, created.event, "the stored event wins on replay");
  assert.equal(store.rows.size, 1);
});

test("an eventId owned by another user is refused without leaking the stored row", async () => {
  const { store, svc } = service();
  const first = input({ eventId: "evt-shared", sessionId: "sess-owner" });
  await svc.appendEvent("user-01", first);

  await assert.rejects(svc.appendEvent("user-02", { ...first, sessionId: "sess-other" }), (error: unknown) => {
    assert.ok(error instanceof LearningEventError);
    assert.equal(error.code, "EVENT_ID_CONFLICT");
    assert.equal(error.status, 409);
    assert.equal(error.message.includes("sess-owner"), false, "the other user's session is not echoed");
    return true;
  });
  assert.equal(store.rows.size, 1);
});

// ---------------------------------------------------------------------------
// Event ordering
// ---------------------------------------------------------------------------

test("completed requires a prior started in the same session, content version and stage", async () => {
  const { store, svc } = service();
  await expectEventError(
    svc.appendEvent("user-01", input({ eventId: "evt-complete-first", type: "completed" })),
    "COMPLETED_WITHOUT_STARTED",
    409
  );

  await svc.appendEvent("user-01", input({ eventId: "evt-started", sessionId: "sess-01", stageKey: "step-01" }));
  await expectEventError(
    svc.appendEvent("user-01", input({ eventId: "evt-complete-other-session", type: "completed", sessionId: "sess-02" })),
    "COMPLETED_WITHOUT_STARTED",
    409
  );
  await expectEventError(
    svc.appendEvent("user-01", input({ eventId: "evt-complete-other-stage", type: "completed", stageKey: "step-02" })),
    "COMPLETED_WITHOUT_STARTED",
    409
  );

  const completed = await svc.appendEvent("user-01", input({ eventId: "evt-completed", type: "completed" }));
  assert.equal(completed.duplicate, false);
  assert.equal(store.rows.size, 2, "only the started and completed events were written");
});

test("with a plan projection, stageKey must belong to the frozen content version", async () => {
  const { store, svc } = service();
  await expectEventError(
    svc.appendEvent("user-01", input({ eventId: "evt-unknown-version", contentVersionId: "cv-missing" })),
    "CONTENT_VERSION_NOT_FOUND",
    404
  );
  await expectEventError(
    svc.appendEvent("user-01", input({ eventId: "evt-unknown-stage", stageKey: "step-99" })),
    "STAGE_NOT_FOUND",
    404
  );
  assert.equal(store.rows.size, 0);
});

test("without any plan projection, the event is recorded by contentVersionId with stageValidated=false", async () => {
  // P1 writer not wired: learning_plan_entries is empty in this deployment.
  const { store, svc } = service({ plans: {} });
  const result = await svc.appendEvent(
    "user-01",
    input({ eventId: "evt-no-projection", contentVersionId: "cv-any", stageKey: "step-any" })
  );
  assert.equal(result.stageValidated, false, "no plan means the stage was not validated");
  assert.equal(result.duplicate, false);
  assert.equal(result.event.contentVersionId, "cv-any");
  assert.equal(result.event.stageKey, "step-any");
  assert.equal(store.rows.size, 1, "the event is still recorded append-only");
});

test("with a plan projection, a matching stage reports stageValidated=true", async () => {
  const { svc } = service();
  const result = await svc.appendEvent("user-01", input({ eventId: "evt-validated" }));
  assert.equal(result.stageValidated, true);
});

test("the type enum and the strict client shape are enforced", async () => {
  const { store, svc } = service();
  const cases: unknown[] = [
    { ...input(), type: "watched" },
    { ...input(), eventId: "bad key" },
    { ...input(), sessionId: "" },
    { ...input(), contentVersionId: "-cv" },
    { ...input(), stageKey: "step/01" },
    { ...input(), sequence: -1 },
    { ...input(), sequence: 1.5 },
    { ...input(), sequence: "1" },
    [],
    null
  ];
  for (const body of cases) {
    await expectEventError(svc.appendEvent("user-01", body), "INVALID_LEARNING_EVENT", 400);
  }
  assert.equal(store.rows.size, 0);
});

// ---------------------------------------------------------------------------
// as-run projection
// ---------------------------------------------------------------------------

test("as-run projects not-started / started / completed per plan entry", async () => {
  const { svc } = service();
  await svc.appendEvent("user-01", input({ eventId: "evt-1", stageKey: "step-01", type: "started", occurredAt: "2026-11-12T09:56:00.000Z" }));
  await svc.appendEvent("user-01", input({ eventId: "evt-2", stageKey: "step-02", type: "started", occurredAt: "2026-11-12T09:57:00.000Z" }));
  await svc.appendEvent("user-01", input({ eventId: "evt-3", stageKey: "step-02", type: "completed", occurredAt: "2026-11-12T09:58:00.000Z" }));

  const rows = await svc.getAsRun("user-01", CONTENT_VERSION);
  assert.deepEqual(rows.map(({ stageKey, state }) => ({ stageKey, state })), [
    { stageKey: "step-01", state: "started" },
    { stageKey: "step-02", state: "completed" },
    { stageKey: "step-03", state: "not-started" }
  ]);
  assert.equal(rows[1].firstStartedAt, "2026-11-12T09:57:00.000Z");
  assert.equal(rows[1].completedAt, "2026-11-12T09:58:00.000Z");
  assert.equal(rows[2].eventCount, 0);
  await expectEventError(svc.getAsRun("user-01", "cv-missing"), "CONTENT_VERSION_NOT_FOUND", 404);
});

test("as-run marks sequence regressions and completed-before-started as out-of-order", () => {
  const record = (overrides: Partial<LearningEvent>): LearningEvent => ({
    eventId: "evt",
    userId: "user-01",
    sessionId: "sess-01",
    type: "started",
    occurredAt: "2026-11-12T09:55:00.000Z",
    receivedAt: "2026-11-12T09:55:00.000Z",
    contentVersionId: CONTENT_VERSION,
    stageKey: "step-01",
    ...overrides
  });

  const rows = projectAsRun({
    contentVersionId: CONTENT_VERSION,
    events: [
      record({ eventId: "evt-seq-2", sequence: 2, receivedAt: "2026-11-12T09:55:02.000Z" }),
      record({ eventId: "evt-seq-1", type: "completed", sequence: 1, receivedAt: "2026-11-12T09:55:03.000Z" }),
      record({ eventId: "evt-completed-first", stageKey: "step-02", type: "completed", receivedAt: "2026-11-12T09:55:04.000Z" }),
      record({ eventId: "evt-late-start", stageKey: "step-02", type: "started", receivedAt: "2026-11-12T09:55:05.000Z" })
    ],
    planEntries: PLAN
  });

  assert.equal(rows[0].state, "out-of-order", "a smaller sequence received later is an anomaly");
  assert.deepEqual(rows[0].outOfOrderEventIds, ["evt-seq-1"]);
  assert.equal(rows[1].state, "out-of-order", "completed received before started is an anomaly");
  assert.deepEqual(rows[1].outOfOrderEventIds, ["evt-completed-first"]);
  assert.equal(rows[2].state, "not-started");
});

test("as-run ignores events from another content version", () => {
  const rows = projectAsRun({
    contentVersionId: CONTENT_VERSION,
    events: [{
      eventId: "evt-other-version",
      userId: "user-01",
      sessionId: "sess-01",
      type: "completed",
      occurredAt: "2026-11-12T09:55:00.000Z",
      receivedAt: "2026-11-12T09:55:00.000Z",
      contentVersionId: "cv-other",
      stageKey: "step-01"
    }],
    planEntries: PLAN
  });
  assert.deepEqual(rows.map((row) => row.state), ["not-started", "not-started", "not-started"]);
});

// ---------------------------------------------------------------------------
// Route: authentication and session ownership
// ---------------------------------------------------------------------------

const originalCwd = process.cwd();
const previousBackend = process.env.STORAGE_BACKEND;
let directory: string;
let productStore: typeof import("../../services/productStore");
let http: typeof import("../../services/learningEventsHttp");

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "lg-learning-events-"));
  process.chdir(directory);
  process.env.STORAGE_BACKEND = "local";
  productStore = await import("../../services/productStore");
  // The handler factory lives in the HTTP service so the route module only
  // exports `dynamic` and `POST` (next build requirement).
  http = await import("../../services/learningEventsHttp");
});

after(async () => {
  process.chdir(originalCwd);
  if (previousBackend === undefined) delete process.env.STORAGE_BACKEND;
  else process.env.STORAGE_BACKEND = previousBackend;
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function signedIn(email: string) {
  const user = await productStore.registerUser({ email, password: "password1" });
  await productStore.verifyEmailToken(await productStore.issueEmailVerificationToken(user.id));
  const token = (await productStore.createSession(user.id)).token;
  return { user, token };
}

function post(body: unknown, token?: string): Request {
  return new Request("http://localhost/api/learning/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { cookie: `learning_guide_session=${token}` } : {})
    },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

test("POST /api/learning/events requires a signed-in user and binds events to the session user", async () => {
  const alice = await signedIn("events-alice@example.test");
  const { store, svc } = service();
  const handler = http.createLearningEventsPostHandler(svc);

  const anonymous = await handler(post(input()));
  assert.equal(anonymous.status, 401);

  const unknownSession = await handler(post(input(), "not-a-session-token"));
  assert.equal(unknownSession.status, 401);

  const spoofed = await handler(post({ ...input(), userId: "victim" }, alice.token));
  assert.equal(spoofed.status, 400);
  assert.equal(((await spoofed.json()) as { code: string }).code, "INVALID_LEARNING_EVENT");
  assert.equal(store.rows.size, 0, "a body-supplied userId is never accepted");

  const accepted = await handler(post(input({ eventId: "evt-route" }), alice.token));
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get("cache-control"), "private, no-store");
  assert.equal(accepted.headers.get("vary"), "Cookie");
  const payload = (await accepted.json()) as { ok: boolean; duplicate: boolean; event: Record<string, unknown> };
  assert.equal(payload.ok, true);
  assert.equal(payload.duplicate, false);
  assert.equal(payload.event.receivedAt, SERVER_NOW);
  assert.equal("userId" in payload.event, false, "the server-owned userId is not echoed");
  assert.equal(store.rows.get("evt-route")?.userId, alice.user.id, "the row belongs to the session user");

  const malformed = await handler(post("{not json", alice.token));
  assert.equal(malformed.status, 400);
});

test("POST rejects reusing another user's eventId without leaking that row", async () => {
  const alice = await signedIn("events-alice-two@example.test");
  const bob = await signedIn("events-bob@example.test");
  const { svc } = service();
  const handler = http.createLearningEventsPostHandler(svc);

  const owned = input({ eventId: "evt-owned-by-alice", sessionId: "sess-alice" });
  assert.equal((await handler(post(owned, alice.token))).status, 200);

  const refused = await handler(post({ ...owned, sessionId: "sess-bob" }, bob.token));
  assert.equal(refused.status, 409);
  const text = await refused.text();
  assert.ok(text.includes("EVENT_ID_CONFLICT"));
  assert.equal(text.includes("sess-alice"), false);
  assert.equal(text.includes(alice.user.id), false);
});
