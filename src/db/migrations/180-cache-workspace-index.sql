-- Add workspace_id to semantic_cache for direct workspace-scoped queries
-- Existing rows get NULL workspace_id (acceptable — will be evicted naturally)

ALTER TABLE semantic_cache
  ADD COLUMN IF NOT EXISTS workspace_id TEXT;

CREATE INDEX IF NOT EXISTS idx_semantic_cache_workspace
  ON semantic_cache (workspace_id, created_at ASC)
  WHERE workspace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_semantic_cache_agent_expires
  ON semantic_cache (agent_id, expires_at DESC);
