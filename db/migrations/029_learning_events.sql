-- 029_learning_events.sql (§14 C8 / §12 learning-event contract).
-- The Portal learning-event domain: an append-only ledger whose eventId is the
-- client's idempotency key, and the read-only projection of the frozen plan the
-- as-run reconciliation joins against. Additive and repeatable (IF NOT EXISTS);
-- mirrored verbatim by the services/persistence/db.ts bootstrap and freshness
-- probe. 017-028 are not edited. No hash/checksum/digest columns: eventId is
-- the only identity and learning time is never derived from content.
-- Rollback: roll back the application and retain both tables (events are
-- append-only learning history; deleting them needs an export/retention decision).
CREATE TABLE IF NOT EXISTS learning_events (
  event_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('started', 'paused', 'resumed', 'completed', 'abandoned')),
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  content_version_id TEXT NOT NULL,
  stage_key TEXT NOT NULL,
  sequence INTEGER CHECK (sequence IS NULL OR sequence >= 0)
);
CREATE INDEX IF NOT EXISTS learning_events_content_idx
  ON learning_events (user_id, content_version_id, stage_key);
CREATE INDEX IF NOT EXISTS learning_events_session_idx
  ON learning_events (session_id, sequence);
CREATE INDEX IF NOT EXISTS learning_events_started_lookup_idx
  ON learning_events (user_id, session_id, content_version_id, stage_key);

-- Read-only projection of the frozen plan (C3 PlanEntry / C6 / C8). The
-- content-projection writer is a separate seam; an unknown content version
-- (no entries) is refused with 404, never accepted on trust.
CREATE TABLE IF NOT EXISTS learning_plan_entries (
  content_version_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  stage_key TEXT NOT NULL,
  order_key TEXT NOT NULL,
  PRIMARY KEY (content_version_id, entry_id)
);
CREATE INDEX IF NOT EXISTS learning_plan_entries_stage_idx
  ON learning_plan_entries (content_version_id, stage_key, order_key);
