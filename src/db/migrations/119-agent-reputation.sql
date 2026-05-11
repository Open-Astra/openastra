-- Agent reputation scores — per-workspace, per-agent success metrics
CREATE TABLE IF NOT EXISTS agent_reputation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  tasks_completed INTEGER DEFAULT 0,
  tasks_failed INTEGER DEFAULT 0,
  total_ratings INTEGER DEFAULT 0,
  positive_ratings INTEGER DEFAULT 0,
  tool_errors INTEGER DEFAULT 0,
  total_tool_calls INTEGER DEFAULT 0,
  avg_confidence NUMERIC(4,3) DEFAULT 0.0,
  confidence_samples INTEGER DEFAULT 0,
  avg_latency_ms NUMERIC(10,2) DEFAULT 0.0,
  latency_samples INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(workspace_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_reputation_workspace
  ON agent_reputation (workspace_id);
