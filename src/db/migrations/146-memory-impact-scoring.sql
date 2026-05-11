CREATE TABLE IF NOT EXISTS memory_impact_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  memory_tier TEXT NOT NULL,
  times_retrieved INT NOT NULL DEFAULT 0,
  times_cited INT NOT NULL DEFAULT 0,
  times_influenced_response INT NOT NULL DEFAULT 0,
  avg_position_in_context REAL,
  last_retrieval_at TIMESTAMPTZ,
  last_citation_at TIMESTAMPTZ,
  impact_score REAL NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, memory_id, memory_tier)
);

CREATE INDEX IF NOT EXISTS idx_impact_scores_ws ON memory_impact_scores(workspace_id);
CREATE INDEX IF NOT EXISTS idx_impact_scores_score ON memory_impact_scores(workspace_id, impact_score DESC);
