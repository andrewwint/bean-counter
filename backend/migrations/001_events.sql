-- 001_events.sql — the append-only event log.
--
-- This table is the system of record. Everything else in bean-counter is a
-- projection of it. Two rules hold everywhere in this codebase:
--   1. APPEND ONLY. No UPDATE, no DELETE against `events`. History is never
--      rewritten; a mistake is corrected by appending a correcting event.
--   2. Quantities in `payload` are integers in a base unit (g / ml / each).
--      Floats never reach this table — zod rejects them at the HTTP boundary.

CREATE TABLE IF NOT EXISTS events (
  sequence      bigserial PRIMARY KEY,          -- global order; the fold reads this
  event_id      uuid        NOT NULL UNIQUE,    -- client-visible id, also an idempotency handle
  stream_id     text        NOT NULL,           -- the item id
  event_type    text        NOT NULL,
  event_version int         NOT NULL DEFAULT 1, -- schema version; readers switch on it
  payload       jsonb       NOT NULL,
  occurred_at   timestamptz NOT NULL,           -- when it happened in the shop
  recorded_at   timestamptz NOT NULL DEFAULT now()
);

-- Per-stream replay (item history endpoint, and the fold's per-item window).
CREATE INDEX IF NOT EXISTS events_stream_sequence_idx ON events (stream_id, sequence);

-- `event_version` is written on every event from day one, even though only v1
-- exists today. The upcasting convention for whoever comes next: when a payload
-- shape changes, DO NOT migrate rows in place — bump the version on new writes
-- and add a pure `upcast_v{n}_to_v{n+1}` step in src/events/schema.ts that is
-- applied on read, chaining old versions forward to the current shape. The log
-- keeps the bytes that were actually true when the event happened.
