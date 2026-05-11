-- Migration 079: Prompt version control
-- Stores versioned snapshots of agent system prompts per workspace.

CREATE TABLE IF NOT EXISTS agent_prompt_versions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     TEXT NOT NULL,
  workspace_id UUID NOT NULL,
  version      INT  NOT NULL,
  system_prompt TEXT NOT NULL,
  label        TEXT,
  created_by   TEXT,
  created_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE (agent_id, workspace_id, version)
);

CREATE INDEX IF NOT EXISTS idx_prompt_versions_agent ON agent_prompt_versions(agent_id, workspace_id);
