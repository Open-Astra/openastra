-- Migration 197: Advanced tool composition with auto-chaining and discovery
-- Tracks compatible tool pairings for automatic workflow generation
-- Enables discovery of effective tool sequences through empirical testing

CREATE TABLE tool_auto_chains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL,
  workspace_id text,
  source_tool text NOT NULL,
  target_tool text NOT NULL,
  compatibility_score numeric(3,2),
  discovered_count int DEFAULT 1,
  last_discovered_at timestamptz,
  created_at timestamptz DEFAULT now(),
  UNIQUE(agent_id, source_tool, target_tool)
);

CREATE INDEX idx_tool_chains_agent ON tool_auto_chains(agent_id);
CREATE INDEX idx_tool_chains_source ON tool_auto_chains(source_tool, compatibility_score DESC);
CREATE INDEX idx_tool_chains_target ON tool_auto_chains(target_tool);
CREATE INDEX idx_tool_chains_workspace ON tool_auto_chains(workspace_id);
