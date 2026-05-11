CREATE TABLE IF NOT EXISTS agent_tournaments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  name TEXT NOT NULL,
  agent_ids TEXT[] NOT NULL,
  test_prompts TEXT[] NOT NULL,
  metric TEXT DEFAULT 'response_quality',
  status TEXT DEFAULT 'pending',
  results JSONB DEFAULT '{}',
  winner_agent_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
