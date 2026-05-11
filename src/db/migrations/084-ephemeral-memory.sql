-- Migration 084: Conversation-scoped ephemeral memory
-- Key-value store that lives only for the duration of a session.

CREATE TABLE IF NOT EXISTS ephemeral_memory (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID    NOT NULL,
  key        TEXT    NOT NULL,
  value      JSONB   NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (session_id, key)
);

CREATE INDEX IF NOT EXISTS idx_ephemeral_session ON ephemeral_memory(session_id);
CREATE INDEX IF NOT EXISTS idx_ephemeral_expires ON ephemeral_memory(expires_at);
