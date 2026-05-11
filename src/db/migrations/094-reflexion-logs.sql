-- 094: Reflexion loop draft/critique/revision logs
CREATE TABLE IF NOT EXISTS reflexion_logs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  turn_index   INT NOT NULL,
  passes       INT NOT NULL DEFAULT 1,
  draft        TEXT NOT NULL,
  critique     TEXT,
  final        TEXT NOT NULL,
  duration_ms  INT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reflexion_session ON reflexion_logs (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reflexion_workspace ON reflexion_logs (workspace_id, created_at DESC);
