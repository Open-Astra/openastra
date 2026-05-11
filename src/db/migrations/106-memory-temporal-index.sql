-- 106: Indexes to support efficient temporal memory queries (time-travel reads)
CREATE INDEX IF NOT EXISTS idx_daily_memory_temporal ON daily_memory (user_id, workspace_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_graph_entities_temporal ON workspace_graph_entities (workspace_id, created_at DESC);
