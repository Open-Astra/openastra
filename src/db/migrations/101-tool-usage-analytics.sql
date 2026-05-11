-- 101: Per-tool usage statistics
CREATE TABLE IF NOT EXISTS tool_usage_stats (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  tool_name    TEXT NOT NULL,
  session_id   TEXT,
  success      BOOLEAN NOT NULL,
  duration_ms  INT NOT NULL,
  error_type   TEXT,                -- null on success, error class/message prefix on failure
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tool_stats_workspace ON tool_usage_stats (workspace_id, tool_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_stats_agent ON tool_usage_stats (agent_id, tool_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_stats_created ON tool_usage_stats (created_at DESC);
