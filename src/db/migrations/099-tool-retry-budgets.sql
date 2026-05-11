-- 099: Per-tool retry budgets and dead-letter queue
CREATE TABLE IF NOT EXISTS tool_retry_budgets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  tool_name    TEXT NOT NULL,
  max_attempts INT NOT NULL DEFAULT 3,
  base_delay_ms INT NOT NULL DEFAULT 500,
  max_delay_ms  INT NOT NULL DEFAULT 10000,
  jitter       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, tool_name)
);

CREATE TABLE IF NOT EXISTS tool_dead_letter (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  tool_name    TEXT NOT NULL,
  arguments    JSONB NOT NULL,
  attempts     INT NOT NULL,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dead_letter_workspace ON tool_dead_letter (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dead_letter_tool ON tool_dead_letter (tool_name, workspace_id);
