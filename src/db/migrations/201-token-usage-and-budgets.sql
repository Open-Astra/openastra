-- 201: token_usage / token_budgets — per-user usage ledger and limits.
-- Previously created lazily at runtime by src/inference/token-budget.ts.

CREATE TABLE IF NOT EXISTS token_usage (
  id SERIAL PRIMARY KEY,
  uid TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  session_id TEXT,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd NUMERIC(10,6) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_token_usage_uid ON token_usage (uid, created_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_agent ON token_usage (agent_id, created_at);

CREATE TABLE IF NOT EXISTS token_budgets (
  id SERIAL PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  daily_limit INTEGER DEFAULT 500000,
  monthly_limit INTEGER DEFAULT 10000000,
  alert_threshold NUMERIC(3,2) DEFAULT 0.80,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
