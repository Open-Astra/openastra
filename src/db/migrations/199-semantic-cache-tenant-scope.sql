-- 199: Tenant-scope the semantic response cache.
-- Cached responses are derived from a user's private context, so every entry
-- is now keyed by (agent_id, uid, workspace_id). Rows written before this
-- migration have no uid and are never served again; purge them.

ALTER TABLE semantic_cache ADD COLUMN IF NOT EXISTS uid TEXT;
ALTER TABLE semantic_cache ADD COLUMN IF NOT EXISTS workspace_id TEXT;

DELETE FROM semantic_cache WHERE uid IS NULL;

CREATE INDEX IF NOT EXISTS idx_semantic_cache_scope
  ON semantic_cache (agent_id, uid, workspace_id, expires_at DESC);
