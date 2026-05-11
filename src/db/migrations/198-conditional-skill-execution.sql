-- Migration 198: Conditional skill execution guards and contexts
-- Enables fine-grained control over skill activation based on conditions
-- Supports time-based, role-based, cost-based, and custom execution guards

CREATE TABLE skill_conditions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id text NOT NULL,
  agent_id text NOT NULL,
  condition_type text, -- 'time', 'role', 'custom', 'cost', 'tier'
  condition_config jsonb,
  enabled boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  UNIQUE(skill_id, agent_id, condition_type)
);

CREATE INDEX idx_skill_conditions_skill_agent ON skill_conditions(skill_id, agent_id);
CREATE INDEX idx_skill_conditions_agent ON skill_conditions(agent_id);
CREATE INDEX idx_skill_conditions_type ON skill_conditions(condition_type);
CREATE INDEX idx_skill_conditions_enabled ON skill_conditions(skill_id, enabled);
