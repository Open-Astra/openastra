CREATE TABLE IF NOT EXISTS team_kb_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  team_id TEXT,
  agent_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT[] DEFAULT '{}',
  relevance_score NUMERIC DEFAULT 1.0,
  citation_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS team_kb_votes (
  entry_id UUID REFERENCES team_kb_entries(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY(entry_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_team_kb_ws ON team_kb_entries (workspace_id, team_id);
CREATE INDEX IF NOT EXISTS idx_team_kb_tags ON team_kb_entries USING GIN (tags);
