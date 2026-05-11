CREATE TABLE IF NOT EXISTS pair_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  generator_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  task TEXT NOT NULL,
  status TEXT DEFAULT 'active' CHECK(status IN ('active','completed','abandoned')),
  quality_score NUMERIC,
  created_at TIMESTAMPTZ DEFAULT now(),
  ended_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS pair_turns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES pair_sessions(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('generate','review','interrupt')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pair_sessions_ws ON pair_sessions (workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_pair_turns_session ON pair_turns (session_id, created_at);
