CREATE TABLE IF NOT EXISTS agent_federation_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  granting_workspace_id UUID NOT NULL,
  receiving_workspace_id UUID NOT NULL,
  agent_id TEXT NOT NULL,
  capabilities JSONB NOT NULL DEFAULT '{}',
  granted_by TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_federation_receiving ON agent_federation_grants(receiving_workspace_id, agent_id);
