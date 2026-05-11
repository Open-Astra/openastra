-- Agent SLAs
CREATE TABLE IF NOT EXISTS agent_slas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  max_latency_ms INTEGER NOT NULL DEFAULT 30000,
  min_confidence NUMERIC(3,2) DEFAULT 0.7,
  max_error_rate NUMERIC(3,2) DEFAULT 0.1,
  backup_agent_id TEXT,
  alert_on_breach BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(workspace_id, agent_id)
);

CREATE TABLE IF NOT EXISTS sla_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  confidence NUMERIC(3,2),
  had_error BOOLEAN DEFAULT false,
  measured_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sla_metrics_agent ON sla_metrics(workspace_id, agent_id, measured_at DESC);
