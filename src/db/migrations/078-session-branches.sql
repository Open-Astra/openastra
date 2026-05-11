-- Migration 078: Conversation branching
-- Allows forking a session at any message index to explore alternate paths.

CREATE TABLE IF NOT EXISTS session_branches (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_session_id UUID NOT NULL,
  branch_session_id UUID NOT NULL,
  from_message_index INT NOT NULL DEFAULT 0,
  label        TEXT,
  workspace_id UUID NOT NULL,
  created_by   TEXT,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_session_branches_parent    ON session_branches(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_session_branches_branch    ON session_branches(branch_session_id);
CREATE INDEX IF NOT EXISTS idx_session_branches_workspace ON session_branches(workspace_id);
