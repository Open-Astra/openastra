-- 029: Cross-workspace agent sharing (recommendation 24)
-- Workspace A can grant workspace B access to its agents.

CREATE TABLE IF NOT EXISTS workspace_agent_grants (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  granting_workspace_id TEXT NOT NULL,
  receiving_workspace_id TEXT NOT NULL,
  agent_id              TEXT NOT NULL,
  readonly              BOOLEAN NOT NULL DEFAULT true,    -- false = can spawn; true = read-only
  granted_by            TEXT NOT NULL,
  granted_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at            TIMESTAMPTZ,                      -- NULL = never

  UNIQUE (granting_workspace_id, receiving_workspace_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_grants_receiving
  ON workspace_agent_grants (receiving_workspace_id, agent_id);

CREATE INDEX IF NOT EXISTS idx_agent_grants_granting
  ON workspace_agent_grants (granting_workspace_id);
