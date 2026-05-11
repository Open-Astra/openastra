-- Migration 145: Temporal Memory Queries
CREATE TABLE IF NOT EXISTS memory_snapshots_temporal (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  snapshot_name TEXT NOT NULL,
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  tier TEXT NOT NULL,
  entry_count INT NOT NULL DEFAULT 0,
  snapshot_data JSONB NOT NULL DEFAULT '[]',
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_temporal_snapshots_ws ON memory_snapshots_temporal(workspace_id, snapshot_at);

CREATE TABLE IF NOT EXISTS memory_change_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  memory_tier TEXT NOT NULL,
  change_type TEXT NOT NULL CHECK (change_type IN ('create', 'update', 'delete', 'merge', 'compact')),
  old_content TEXT,
  new_content TEXT,
  changed_by TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_changelog_ws ON memory_change_log(workspace_id, changed_at);
CREATE INDEX IF NOT EXISTS idx_memory_changelog_memory ON memory_change_log(workspace_id, memory_id);
