CREATE TABLE IF NOT EXISTS slo_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  agent_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  threshold NUMERIC(10,4) NOT NULL,
  window_minutes INT NOT NULL DEFAULT 60,
  alert_webhook_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS slo_violations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slo_id UUID NOT NULL REFERENCES slo_definitions(id) ON DELETE CASCADE,
  measured_value NUMERIC(10,4) NOT NULL,
  threshold NUMERIC(10,4) NOT NULL,
  violated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_slo_definitions_workspace ON slo_definitions(workspace_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_slo_violations_slo ON slo_violations(slo_id, violated_at DESC);
