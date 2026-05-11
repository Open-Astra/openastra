-- Agent config version history with rollback support
CREATE TABLE IF NOT EXISTS agent_config_versions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  version      INT NOT NULL,
  config       JSONB NOT NULL,
  label        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by   TEXT,
  UNIQUE (agent_id, version)
);
CREATE INDEX IF NOT EXISTS idx_agent_versions_agent_workspace ON agent_config_versions (agent_id, workspace_id);
