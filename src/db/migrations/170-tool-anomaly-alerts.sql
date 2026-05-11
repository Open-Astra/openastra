-- Migration 170: Tool Anomaly Alerts
-- Persists anomaly alerts detected by the tool anomaly detector.

CREATE TABLE IF NOT EXISTS tool_anomaly_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  tool_name TEXT NOT NULL,
  agent_id TEXT,
  uid TEXT,
  description TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_anomaly_alerts_severity
  ON tool_anomaly_alerts (severity, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_anomaly_alerts_tool
  ON tool_anomaly_alerts (tool_name, created_at DESC);
