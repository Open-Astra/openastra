CREATE TABLE IF NOT EXISTS agent_spawn_tree (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  root_trace_id TEXT NOT NULL,
  parent_trace_id TEXT,
  child_trace_id TEXT NOT NULL,
  parent_agent_id TEXT NOT NULL,
  child_agent_id TEXT NOT NULL,
  spawned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  depth INT NOT NULL DEFAULT 1,
  total_cost_usd NUMERIC(12,6) DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_spawn_tree_root ON agent_spawn_tree(workspace_id, root_trace_id);
