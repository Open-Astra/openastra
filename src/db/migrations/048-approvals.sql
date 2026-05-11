-- Approval requests: add columns needed for human-in-the-loop tool execution.
-- The approval_requests table was created in 013-advanced-features.sql.
-- This migration adds columns that 013 does not have.

ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS workspace_id UUID;
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS uid TEXT;
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS tool_name TEXT;
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS tool_args JSONB NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_approval_requests_workspace ON approval_requests(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_approval_requests_session ON approval_requests(session_id);
