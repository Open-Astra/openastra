-- 105: Full version history for memory entries
CREATE TABLE IF NOT EXISTS memory_versions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  memory_id    TEXT NOT NULL,
  memory_type  TEXT NOT NULL,   -- 'daily' | 'graph' | 'procedural'
  version      INT NOT NULL,
  content      TEXT NOT NULL,   -- snapshot of content at this version
  metadata     JSONB,
  changed_by   TEXT,
  change_note  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_memory_versions_id ON memory_versions (memory_id, memory_type, version DESC);
CREATE INDEX IF NOT EXISTS idx_memory_versions_workspace ON memory_versions (workspace_id, created_at DESC);
