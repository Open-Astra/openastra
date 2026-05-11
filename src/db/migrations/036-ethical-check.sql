-- Per-user ethical guideline configs and check audit log.
-- Used by the ethical_check tool for content alignment validation.

CREATE TABLE IF NOT EXISTS agent_ethical_configs (
  uid         TEXT PRIMARY KEY,
  value       JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ethical_check_log (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  uid         TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  score       INTEGER NOT NULL,
  violations  JSONB NOT NULL DEFAULT '[]',
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ethical_check_log_uid ON ethical_check_log(uid, checked_at DESC);
