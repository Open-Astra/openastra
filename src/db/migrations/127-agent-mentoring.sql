CREATE TABLE IF NOT EXISTS mentorship_pairs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  mentor_id TEXT NOT NULL,
  mentee_id TEXT NOT NULL,
  focus TEXT[] DEFAULT '{}',
  status TEXT DEFAULT 'active',
  sessions_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mentoring_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pair_id UUID REFERENCES mentorship_pairs(id) ON DELETE CASCADE,
  insights JSONB NOT NULL,
  applied_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mentorship_ws ON mentorship_pairs (workspace_id, status);
