-- Migration 186: Token budget prediction and estimation
-- Tracks token usage metrics per agent and model for budget forecasting
-- Enables adaptive token allocation and cost prediction

ALTER TABLE agent_configs ADD COLUMN estimated_token_rate numeric(5,2) DEFAULT 0.00;

CREATE TABLE token_estimates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL,
  workspace_id text,
  model_id text NOT NULL,
  avg_prompt_tokens int,
  avg_completion_tokens int,
  p95_total_tokens int,
  samples_count int DEFAULT 0,
  last_updated timestamptz,
  UNIQUE(agent_id, model_id)
);

CREATE INDEX idx_token_estimates_agent_model ON token_estimates(agent_id, model_id);
CREATE INDEX idx_token_estimates_workspace ON token_estimates(workspace_id);
