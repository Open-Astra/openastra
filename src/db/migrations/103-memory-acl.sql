-- 103: Per-entry memory access control lists
CREATE TABLE IF NOT EXISTS memory_acl (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  memory_id    TEXT NOT NULL,       -- references daily_memory.id or graph_entities.id
  memory_type  TEXT NOT NULL,       -- 'daily' | 'graph' | 'procedural'
  visibility   TEXT NOT NULL DEFAULT 'private',  -- 'private' | 'workspace' | 'cross-workspace'
  allowed_uids TEXT[] NOT NULL DEFAULT '{}',     -- explicit uid grants
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, memory_id, memory_type)
);
CREATE INDEX IF NOT EXISTS idx_memory_acl_memory ON memory_acl (memory_id, memory_type);
CREATE INDEX IF NOT EXISTS idx_memory_acl_workspace ON memory_acl (workspace_id);
