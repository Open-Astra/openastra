-- Migration 194: Extended thinking and reasoning token tracking
-- Enables Claude extended thinking mode with dedicated reasoning tokens
-- Tracks thinking sessions and token consumption for budget management

ALTER TABLE agent_configs ADD COLUMN budget_thinking_tokens int DEFAULT 0;
ALTER TABLE agent_configs ADD COLUMN use_extended_thinking boolean DEFAULT false;

CREATE TABLE thinking_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL,
  session_id text NOT NULL,
  round int,
  thinking_content text,
  thinking_tokens int,
  thinking_duration_ms int,
  thought_signature text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_thinking_sessions_agent ON thinking_sessions(agent_id);
CREATE INDEX idx_thinking_sessions_session ON thinking_sessions(session_id, round);
CREATE INDEX idx_thinking_sessions_created ON thinking_sessions(created_at DESC);
