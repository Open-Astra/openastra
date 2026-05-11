-- Migration 144: Cross-Agent Memory Sharing Grants
CREATE TABLE IF NOT EXISTS memory_sharing_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  grantor_agent_id TEXT NOT NULL,
  grantee_agent_id TEXT NOT NULL,
  memory_tier TEXT NOT NULL CHECK (memory_tier IN ('daily', 'profile', 'graph', 'procedural', 'all')),
  category_filter TEXT,
  permission TEXT NOT NULL CHECK (permission IN ('read', 'read_write')) DEFAULT 'read',
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  UNIQUE(workspace_id, grantor_agent_id, grantee_agent_id, memory_tier)
);

CREATE INDEX IF NOT EXISTS idx_memory_grants_grantee ON memory_sharing_grants(workspace_id, grantee_agent_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_memory_grants_grantor ON memory_sharing_grants(workspace_id, grantor_agent_id);

CREATE TABLE IF NOT EXISTS memory_share_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id UUID NOT NULL REFERENCES memory_sharing_grants(id),
  workspace_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('read', 'write', 'denied')),
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
