-- 098: Conversation state checkpoints (save/restore)
CREATE TABLE IF NOT EXISTS conversation_checkpoints (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  label        TEXT,                     -- optional human label
  message_count INT NOT NULL,
  token_estimate INT NOT NULL DEFAULT 0,
  snapshot     JSONB NOT NULL,           -- full ChatMessage[] array
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON conversation_checkpoints (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_checkpoints_workspace ON conversation_checkpoints (workspace_id, created_at DESC);
