CREATE TABLE IF NOT EXISTS agent_context_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  from_agent_id TEXT NOT NULL,
  to_agent_id TEXT NOT NULL,
  session_id TEXT,
  handoff_summary TEXT NOT NULL,
  key_findings TEXT[] NOT NULL DEFAULT '{}',
  open_questions TEXT[] NOT NULL DEFAULT '{}',
  constraints TEXT[] NOT NULL DEFAULT '{}',
  context_data JSONB NOT NULL DEFAULT '{}',
  tools_in_progress TEXT[] NOT NULL DEFAULT '{}',
  transfer_status TEXT NOT NULL CHECK (transfer_status IN ('preparing','ready','accepted','rejected','completed')) DEFAULT 'preparing',
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_context_transfers_ws ON agent_context_transfers(workspace_id);
CREATE INDEX IF NOT EXISTS idx_context_transfers_to ON agent_context_transfers(workspace_id, to_agent_id);
CREATE INDEX IF NOT EXISTS idx_context_transfers_from ON agent_context_transfers(workspace_id, from_agent_id);