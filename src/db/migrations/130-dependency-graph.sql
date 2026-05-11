CREATE TABLE IF NOT EXISTS task_graph_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','ready','running','completed','failed')),
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS task_graph_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  from_node_id UUID REFERENCES task_graph_nodes(id) ON DELETE CASCADE,
  to_node_id UUID REFERENCES task_graph_nodes(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(from_node_id, to_node_id)
);

CREATE INDEX IF NOT EXISTS idx_tg_nodes_ws ON task_graph_nodes (workspace_id);
CREATE INDEX IF NOT EXISTS idx_tg_edges_ws ON task_graph_edges (workspace_id);
