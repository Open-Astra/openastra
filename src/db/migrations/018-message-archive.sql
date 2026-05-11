CREATE TABLE IF NOT EXISTS message_archive (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  tool_calls JSONB,
  tool_call_id TEXT,
  token_estimate INT,
  timestamp BIGINT,
  archived_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS message_archive_session_id_idx ON message_archive (session_id);
CREATE INDEX IF NOT EXISTS message_archive_user_id_idx ON message_archive (user_id);
