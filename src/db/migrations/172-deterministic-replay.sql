-- Deterministic Replay: record every inference call + tool result during
-- agent execution for exact replay, debugging, and regression testing.

CREATE TABLE IF NOT EXISTS agent_recordings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  -- Recording metadata
  status        TEXT NOT NULL DEFAULT 'recording',  -- recording | completed | failed
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ,
  total_turns   INT NOT NULL DEFAULT 0,
  total_tool_calls INT NOT NULL DEFAULT 0,
  -- Replay metadata
  replay_count  INT NOT NULL DEFAULT 0,
  last_replayed_at TIMESTAMPTZ,
  created_by    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_recordings_workspace ON agent_recordings(workspace_id);
CREATE INDEX IF NOT EXISTS idx_agent_recordings_session ON agent_recordings(session_id);
CREATE INDEX IF NOT EXISTS idx_agent_recordings_agent ON agent_recordings(agent_id);

-- Individual recorded events within a recording
CREATE TABLE IF NOT EXISTS recording_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id  UUID NOT NULL REFERENCES agent_recordings(id) ON DELETE CASCADE,
  sequence_num  INT NOT NULL,           -- order within recording
  event_type    TEXT NOT NULL,          -- inference_request | inference_response | tool_call | tool_result | memory_read | memory_write
  -- Captured data
  payload       JSONB NOT NULL,         -- full request/response data
  duration_ms   INT,
  -- For replay comparison
  checksum      TEXT,                   -- SHA-256 of payload for drift detection
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(recording_id, sequence_num)
);

CREATE INDEX IF NOT EXISTS idx_recording_events_recording ON recording_events(recording_id);

-- Replay runs: each replay attempt with drift report
CREATE TABLE IF NOT EXISTS replay_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id  UUID NOT NULL REFERENCES agent_recordings(id) ON DELETE CASCADE,
  workspace_id  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running',  -- running | completed | diverged | failed
  -- Drift report
  total_events  INT NOT NULL DEFAULT 0,
  matched_events INT NOT NULL DEFAULT 0,
  diverged_at_seq INT,                  -- sequence number where first divergence occurred
  drift_report  JSONB,                  -- detailed diff of divergences
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ,
  created_by    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_replay_runs_recording ON replay_runs(recording_id);
