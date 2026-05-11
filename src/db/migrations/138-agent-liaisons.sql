CREATE TABLE IF NOT EXISTS agent_liaisons (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  team_a TEXT NOT NULL,
  team_b TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  handoff_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_liaisons_ws_active ON agent_liaisons (workspace_id, active);

CREATE TABLE IF NOT EXISTS liaison_handoffs (
  id UUID PRIMARY KEY,
  liaison_id UUID NOT NULL REFERENCES agent_liaisons(id) ON DELETE CASCADE,
  from_team TEXT NOT NULL,
  to_team TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
