CREATE TABLE IF NOT EXISTS memory_merge_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  source_agent_id TEXT NOT NULL,
  target_agent_id TEXT NOT NULL,
  merge_strategy TEXT NOT NULL CHECK (merge_strategy IN ('deep_copy', 'shared_reference', 'clean_slate', 'selective')),
  tiers_included TEXT[] NOT NULL DEFAULT '{daily,profile,graph,procedural}',
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')) DEFAULT 'pending',
  entries_merged INT NOT NULL DEFAULT 0,
  entries_skipped INT NOT NULL DEFAULT 0,
  entries_conflicted INT NOT NULL DEFAULT 0,
  conflict_resolution TEXT CHECK (conflict_resolution IN ('keep_source', 'keep_target', 'keep_both', 'manual')),
  error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_merge_ops_ws ON memory_merge_operations(workspace_id);
CREATE INDEX IF NOT EXISTS idx_merge_ops_target ON memory_merge_operations(target_agent_id);
