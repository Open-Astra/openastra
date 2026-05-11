CREATE TABLE IF NOT EXISTS agent_ab_tests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  name TEXT NOT NULL,
  agent_a_id TEXT NOT NULL,
  agent_b_id TEXT NOT NULL,
  traffic_split NUMERIC DEFAULT 0.5,
  metric TEXT DEFAULT 'user_rating',
  status TEXT DEFAULT 'active',
  results JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ab_tests_workspace ON agent_ab_tests(workspace_id, status);
