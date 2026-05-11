-- Agent trace records for the trace viewer
CREATE TABLE IF NOT EXISTS agent_traces (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id             TEXT NOT NULL,
  agent_id               TEXT NOT NULL,
  workspace_id           TEXT,
  uid                    TEXT NOT NULL,
  started_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at            TIMESTAMPTZ,
  duration_ms            INT,
  prompt_tokens          INT NOT NULL DEFAULT 0,
  completion_tokens      INT NOT NULL DEFAULT 0,
  total_tokens           INT NOT NULL DEFAULT 0,
  tool_calls             JSONB NOT NULL DEFAULT '[]',
  memory_reads           JSONB NOT NULL DEFAULT '[]',
  circuit_breaker_events JSONB NOT NULL DEFAULT '[]',
  final_status           TEXT NOT NULL DEFAULT 'running'
                           CHECK (final_status IN ('running', 'completed', 'timeout', 'error')),
  error_message          TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_traces_session ON agent_traces (session_id);
CREATE INDEX IF NOT EXISTS idx_agent_traces_agent ON agent_traces (agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_traces_workspace ON agent_traces (workspace_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_traces_uid ON agent_traces (uid, started_at DESC);
