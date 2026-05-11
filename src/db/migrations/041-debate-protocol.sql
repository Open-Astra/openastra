CREATE TABLE IF NOT EXISTS debate_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  topic TEXT NOT NULL,
  agent_a_id TEXT NOT NULL,
  agent_b_id TEXT NOT NULL,
  judge_agent_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  synthesis TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_debate_sessions_workspace ON debate_sessions(workspace_id);
