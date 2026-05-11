CREATE TABLE IF NOT EXISTS agent_test_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  agent_id TEXT NOT NULL,
  run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  passed INT NOT NULL DEFAULT 0,
  failed INT NOT NULL DEFAULT 0,
  results JSONB NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_agent_test_results_workspace ON agent_test_results(workspace_id, agent_id);
