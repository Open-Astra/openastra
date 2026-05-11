CREATE TABLE IF NOT EXISTS swarm_budgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  swarm_id TEXT NOT NULL,
  total_token_budget INT NOT NULL,
  total_cost_budget_cents INT NOT NULL DEFAULT 0,
  spent_tokens INT NOT NULL DEFAULT 0,
  spent_cost_cents INT NOT NULL DEFAULT 0,
  allocation_strategy TEXT NOT NULL CHECK (allocation_strategy IN ('equal','proportional','priority','dynamic')) DEFAULT 'equal',
  status TEXT NOT NULL CHECK (status IN ('active','exhausted','completed')) DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, swarm_id)
);
CREATE TABLE IF NOT EXISTS swarm_agent_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  swarm_budget_id UUID NOT NULL REFERENCES swarm_budgets(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  allocated_tokens INT NOT NULL DEFAULT 0,
  spent_tokens INT NOT NULL DEFAULT 0,
  allocated_cost_cents INT NOT NULL DEFAULT 0,
  spent_cost_cents INT NOT NULL DEFAULT 0,
  priority INT NOT NULL DEFAULT 1,
  throttled BOOLEAN NOT NULL DEFAULT false,
  terminated BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(swarm_budget_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_swarm_budgets_ws ON swarm_budgets(workspace_id);
CREATE INDEX IF NOT EXISTS idx_swarm_allocations_budget ON swarm_agent_allocations(swarm_budget_id);