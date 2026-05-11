CREATE TABLE IF NOT EXISTS agent_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  from_agent_id TEXT NOT NULL,
  to_agent_id TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'text',
  content JSONB NOT NULL,
  in_reply_to UUID,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_to ON agent_messages(to_agent_id, workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_messages_workspace ON agent_messages(workspace_id, created_at DESC);
