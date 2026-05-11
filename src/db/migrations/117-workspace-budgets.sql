-- Workspace budget pools
CREATE TABLE IF NOT EXISTS workspace_budgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL UNIQUE,
  total_budget_usd NUMERIC(10,4) NOT NULL DEFAULT 100.0,
  spent_usd NUMERIC(10,4) NOT NULL DEFAULT 0.0,
  period_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  period_end TIMESTAMPTZ,
  per_agent_cap_usd NUMERIC(10,4),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS budget_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  amount_usd NUMERIC(10,6) NOT NULL,
  description TEXT,
  inference_tokens INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_budget_tx_workspace ON budget_transactions(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_budget_tx_agent ON budget_transactions(workspace_id, agent_id, created_at DESC);
