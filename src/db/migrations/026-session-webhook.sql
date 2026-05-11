-- 021: Session-scoped output webhooks
-- Adds webhook_url to sessions so clients can register a URL
-- at session creation and receive every agent turn's output.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS webhook_url TEXT;

CREATE INDEX IF NOT EXISTS idx_sessions_webhook_url
  ON sessions (webhook_url)
  WHERE webhook_url IS NOT NULL;
