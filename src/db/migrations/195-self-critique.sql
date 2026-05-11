-- Migration 195: Agent self-evaluation and critique loops
-- Enables agents to self-evaluate and revise responses for quality improvement
-- Tracks critique cycles and response evolution

ALTER TABLE agent_configs ADD COLUMN self_critique_enabled boolean DEFAULT false;
ALTER TABLE agent_configs ADD COLUMN self_critique_passes int DEFAULT 1;

CREATE TABLE critique_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL,
  session_id text NOT NULL,
  round int,
  original_response text,
  critique text,
  revised_response text,
  passes int,
  duration_ms int,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_critique_logs_agent ON critique_logs(agent_id);
CREATE INDEX idx_critique_logs_session ON critique_logs(session_id, round);
CREATE INDEX idx_critique_logs_created ON critique_logs(created_at DESC);
