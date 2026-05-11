CREATE TABLE IF NOT EXISTS consensus_rounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  description TEXT,
  participants TEXT[] NOT NULL,
  required_majority NUMERIC DEFAULT 0.667,
  status TEXT DEFAULT 'open' CHECK(status IN ('open','resolved','failed','timeout')),
  result TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS consensus_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id UUID REFERENCES consensus_rounds(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  vote TEXT NOT NULL CHECK(vote IN ('agree','disagree','abstain')),
  reasoning TEXT,
  cast_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(round_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_consensus_ws ON consensus_rounds (workspace_id, status);
