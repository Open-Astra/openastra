-- Migration 080: Cross-workspace agent call grants
-- Allows one workspace to invoke an agent owned by another workspace.

CREATE TABLE IF NOT EXISTS cross_workspace_grants (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grantor_workspace_id UUID NOT NULL,
  grantee_workspace_id UUID NOT NULL,
  agent_id            TEXT NOT NULL,
  granted_by          TEXT NOT NULL,
  created_at          TIMESTAMPTZ DEFAULT now(),
  UNIQUE (grantor_workspace_id, grantee_workspace_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_cwg_grantor  ON cross_workspace_grants(grantor_workspace_id);
CREATE INDEX IF NOT EXISTS idx_cwg_grantee  ON cross_workspace_grants(grantee_workspace_id);
