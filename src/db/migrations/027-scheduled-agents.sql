-- 027: Scheduled agents from DB table (recommendation 18)
-- Teams can schedule agent runs without a code deploy.

CREATE TABLE IF NOT EXISTS scheduled_agents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    TEXT,
  agent_id        TEXT NOT NULL,
  cron_expression TEXT NOT NULL,          -- e.g. "0 9 * * 1-5"
  input_message   TEXT NOT NULL,
  surface         TEXT NOT NULL DEFAULT 'chat',
  surface_id      TEXT NOT NULL DEFAULT 'scheduled',
  enabled         BOOLEAN NOT NULL DEFAULT true,
  last_run_at     TIMESTAMPTZ,
  last_run_error  TEXT,
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_agents_enabled
  ON scheduled_agents (enabled) WHERE enabled = true;

CREATE INDEX IF NOT EXISTS idx_scheduled_agents_workspace
  ON scheduled_agents (workspace_id);
