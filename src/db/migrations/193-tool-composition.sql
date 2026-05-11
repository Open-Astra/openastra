-- Migration 193: Tool composition, dependency, and chaining
-- Enables agents to define multi-step tool workflows and compositions
-- Tracks success/failure of tool chains for optimization

CREATE TABLE tool_compositions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL,
  workspace_id text,
  composition_name text,
  tool_chain text[] NOT NULL,
  input_mappings jsonb,
  success_count int DEFAULT 0,
  failure_count int DEFAULT 0,
  last_executed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  UNIQUE(agent_id, composition_name)
);

CREATE INDEX idx_tool_compositions_agent ON tool_compositions(agent_id);
CREATE INDEX idx_tool_compositions_workspace ON tool_compositions(workspace_id);
CREATE INDEX idx_tool_compositions_last_exec ON tool_compositions(agent_id, last_executed_at DESC);
