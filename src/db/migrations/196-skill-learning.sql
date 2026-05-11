-- Migration 196: Feedback-driven skill performance and evolution
-- Tracks skill execution metrics and user ratings for continuous improvement
-- Enables data-driven skill optimization and learning

CREATE TABLE skill_performance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id text NOT NULL,
  agent_id text NOT NULL,
  workspace_id text,
  execution_count int DEFAULT 0,
  success_rate numeric(5,2),
  avg_duration_ms int,
  user_ratings jsonb DEFAULT '{}'::jsonb,
  last_rating_date date,
  evolved_at timestamptz,
  created_at timestamptz DEFAULT now(),
  UNIQUE(skill_id, agent_id)
);

CREATE INDEX idx_skill_performance_skill ON skill_performance(skill_id);
CREATE INDEX idx_skill_performance_agent ON skill_performance(agent_id, success_rate DESC);
CREATE INDEX idx_skill_performance_workspace ON skill_performance(workspace_id);
CREATE INDEX idx_skill_performance_evolved ON skill_performance(evolved_at DESC);
