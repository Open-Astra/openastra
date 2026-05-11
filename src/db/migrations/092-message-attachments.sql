-- Migration 092: Message attachments (multi-modal input)
-- Stores references to images/files attached to chat messages.

CREATE TABLE IF NOT EXISTS message_attachments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   UUID NOT NULL,
  message_index INT NOT NULL,
  workspace_id UUID NOT NULL,
  mime_type    TEXT NOT NULL,
  filename     TEXT,
  storage_url  TEXT NOT NULL,
  size_bytes   BIGINT,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attachments_session ON message_attachments(session_id, message_index);
