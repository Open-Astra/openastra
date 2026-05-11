-- Linear channel: label→agent mappings + webhook dedup

CREATE TABLE IF NOT EXISTS linear_label_agent_mappings (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  TEXT NOT NULL,
  label_name    TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, label_name)
);

CREATE INDEX IF NOT EXISTS idx_linear_mappings_workspace
  ON linear_label_agent_mappings(workspace_id);

CREATE INDEX IF NOT EXISTS idx_linear_mappings_label
  ON linear_label_agent_mappings(label_name);

-- Dedup table keyed by synthetic delivery ID (Linear has no delivery header).
-- Key format: "type:action:dataId:updatedAt" — deterministic, shared between
-- webhook and heartbeat paths so neither double-processes.

CREATE TABLE IF NOT EXISTS linear_webhook_events (
  delivery_id   TEXT PRIMARY KEY,
  event_type    TEXT NOT NULL,
  action        TEXT NOT NULL,
  issue_id      TEXT,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_linear_events_issue
  ON linear_webhook_events(issue_id);

CREATE INDEX IF NOT EXISTS idx_linear_events_processed
  ON linear_webhook_events(processed_at);

-- Extend heartbeat_configs type constraint to include 'linear'.
-- The type column uses a CHECK constraint — we need to drop and recreate it.
DO $$
BEGIN
  ALTER TABLE heartbeat_configs DROP CONSTRAINT IF EXISTS heartbeat_configs_type_check;
  ALTER TABLE heartbeat_configs
    ADD CONSTRAINT heartbeat_configs_type_check
    CHECK (type IN ('rss', 'http', 'github', 'linear'));
EXCEPTION WHEN undefined_table THEN
  -- heartbeat_configs doesn't exist yet — skip
  NULL;
END $$;
