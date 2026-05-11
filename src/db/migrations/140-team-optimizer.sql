CREATE TABLE IF NOT EXISTS team_performance_analyses (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  team_id TEXT,
  analysis JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_team_perf_ws_created ON team_performance_analyses (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS team_recommendations (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  recommended_agents TEXT[] NOT NULL,
  reasoning TEXT[],
  estimated_success_rate NUMERIC,
  estimated_cost NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_team_rec_ws_created ON team_recommendations (workspace_id, created_at DESC);
