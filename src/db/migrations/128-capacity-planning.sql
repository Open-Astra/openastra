CREATE TABLE IF NOT EXISTS capacity_estimates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  team_id TEXT,
  horizon TEXT NOT NULL,
  estimate JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_capacity_ws ON capacity_estimates (workspace_id, created_at DESC);
