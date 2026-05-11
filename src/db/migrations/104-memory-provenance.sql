-- 104: Memory provenance — who/what created each entry
ALTER TABLE daily_memory
  ADD COLUMN IF NOT EXISTS created_by_agent TEXT,
  ADD COLUMN IF NOT EXISTS created_by_tool  TEXT,
  ADD COLUMN IF NOT EXISTS source_session_id TEXT;

CREATE TABLE IF NOT EXISTS memory_provenance_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  memory_id    TEXT NOT NULL,
  memory_type  TEXT NOT NULL,   -- 'daily' | 'graph' | 'procedural'
  action       TEXT NOT NULL,   -- 'created' | 'updated' | 'deleted'
  actor_type   TEXT NOT NULL,   -- 'agent' | 'tool' | 'user' | 'system'
  actor_id     TEXT NOT NULL,
  session_id   TEXT,
  changed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_provenance_memory ON memory_provenance_log (memory_id, memory_type, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_provenance_workspace ON memory_provenance_log (workspace_id, changed_at DESC);
