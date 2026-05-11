CREATE TABLE IF NOT EXISTS agent_schedules (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  schedule JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, agent_id)
);

CREATE TABLE IF NOT EXISTS agent_maintenance_windows (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  window_from TIMESTAMPTZ NOT NULL,
  window_to TIMESTAMPTZ NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_maint_ws_agent ON agent_maintenance_windows (workspace_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_maint_window ON agent_maintenance_windows (window_from, window_to);
