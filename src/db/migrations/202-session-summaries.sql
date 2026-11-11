-- 202: session_summaries — cross-session context bridge.
-- Previously created lazily at runtime by src/memory/context-bridge.ts.

CREATE TABLE IF NOT EXISTS session_summaries (
  id SERIAL PRIMARY KEY,
  uid TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE,
  summary TEXT NOT NULL,
  topics TEXT[] DEFAULT '{}',
  key_decisions TEXT[] DEFAULT '{}',
  pending_actions TEXT[] DEFAULT '{}',
  message_count INTEGER DEFAULT 0,
  duration_minutes INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_session_summaries_uid ON session_summaries (uid, created_at DESC);
