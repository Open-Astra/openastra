-- Dynamic agent configurations (replaces hardcoded agents)
CREATE TABLE IF NOT EXISTS agent_configs (
  id              TEXT PRIMARY KEY,
  workspace_id    UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  display_name    TEXT NOT NULL,
  tier            TEXT NOT NULL DEFAULT 'free',
  model           JSONB NOT NULL,
  system_prompt   TEXT NOT NULL,
  tools           JSONB NOT NULL DEFAULT '{"allow":[],"deny":[]}',
  skills          TEXT[] NOT NULL DEFAULT '{}',
  session_config  JSONB NOT NULL DEFAULT '{"dailyResetHour":4,"idleTimeoutMinutes":120,"maxContextMessages":50}',
  spawn_config    JSONB NOT NULL DEFAULT '{"enabled":false,"allowedTargets":[],"maxDepth":2}',
  created_by      TEXT NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_configs_workspace ON agent_configs(workspace_id);
