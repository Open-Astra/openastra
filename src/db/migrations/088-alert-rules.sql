-- Migration 088: Alert rules engine
-- User-defined thresholds that fire webhooks when metrics cross limits.

CREATE TABLE IF NOT EXISTS alert_rules (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID NOT NULL,
  name           TEXT NOT NULL,
  metric         TEXT NOT NULL CHECK (metric IN ('cost_usd','error_rate','latency_p99_ms','token_count')),
  operator       TEXT NOT NULL CHECK (operator IN ('gt','lt','gte','lte')),
  threshold      NUMERIC NOT NULL,
  window_minutes INT  NOT NULL DEFAULT 60,
  webhook_url    TEXT,
  email_to       TEXT[],
  enabled        BOOLEAN NOT NULL DEFAULT true,
  last_fired_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alert_rules_workspace ON alert_rules(workspace_id);
CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled   ON alert_rules(enabled) WHERE enabled = true;
