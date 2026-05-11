CREATE TABLE IF NOT EXISTS agent_specialization_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  tool_usage JSONB NOT NULL DEFAULT '{}',
  skill_usage JSONB NOT NULL DEFAULT '{}',
  task_categories JSONB NOT NULL DEFAULT '{}',
  success_by_category JSONB NOT NULL DEFAULT '{}',
  recommended_tools TEXT[] NOT NULL DEFAULT '{}',
  recommended_skills TEXT[] NOT NULL DEFAULT '{}',
  recommended_prompt_additions TEXT,
  specialization_score REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_spec_evolution_ws ON agent_specialization_snapshots(workspace_id, agent_id, snapshot_at DESC);

CREATE TABLE IF NOT EXISTS agent_evolution_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  suggestion_type TEXT NOT NULL CHECK (suggestion_type IN ('add_tool', 'remove_tool', 'add_skill', 'remove_skill', 'prompt_update', 'temperature_change')),
  suggestion_detail TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  rationale TEXT NOT NULL,
  applied BOOLEAN NOT NULL DEFAULT false,
  applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_evolution_suggestions_ws ON agent_evolution_suggestions(workspace_id, agent_id);
