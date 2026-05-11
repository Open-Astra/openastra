-- 102: Whisper hint propagation log across spawn tree
CREATE TABLE IF NOT EXISTS whisper_chain_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  root_session_id TEXT NOT NULL,    -- top-level session that started the chain
  session_id      TEXT NOT NULL,    -- session that received the whisper
  parent_session_id TEXT,           -- immediate parent session
  depth           INT NOT NULL DEFAULT 0,
  whisper         TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_whisper_root ON whisper_chain_log (root_session_id, depth);
CREATE INDEX IF NOT EXISTS idx_whisper_session ON whisper_chain_log (session_id);
