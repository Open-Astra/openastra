CREATE TABLE IF NOT EXISTS team_health_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  team_id TEXT,
  time_window TEXT NOT NULL,
  period_from TIMESTAMPTZ,
  period_to TIMESTAMPTZ,
  metrics JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_team_health_ws ON team_health_snapshots (workspace_id, team_id, created_at DESC);
