CREATE TABLE IF NOT EXISTS circuit_breaker_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  total_requests INT NOT NULL DEFAULT 0,
  error_rate NUMERIC(6,4) NOT NULL DEFAULT 0,
  transitioned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cb_history_provider ON circuit_breaker_history(provider, transitioned_at DESC);
