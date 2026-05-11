-- Agent Debugger: step-through debugging sessions with breakpoints,
-- state snapshots, and inspection of agent loop internals.

CREATE TABLE IF NOT EXISTS debug_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  TEXT NOT NULL,
  session_id    TEXT NOT NULL,          -- the agent session being debugged
  agent_id      TEXT NOT NULL,
  -- Debug state
  status        TEXT NOT NULL DEFAULT 'paused',  -- paused | stepping | running | completed
  current_turn  INT NOT NULL DEFAULT 0,
  current_phase TEXT NOT NULL DEFAULT 'pre_inference',  -- pre_inference | post_inference | pre_tool | post_tool | post_turn
  -- Breakpoints
  breakpoints   JSONB NOT NULL DEFAULT '[]',  -- [{"type":"tool","name":"code_execute"}, {"type":"turn","number":3}]
  -- Configuration
  auto_capture  BOOLEAN NOT NULL DEFAULT true,  -- capture state snapshots automatically
  max_turns     INT NOT NULL DEFAULT 50,
  -- Metadata
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_debug_sessions_workspace ON debug_sessions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_debug_sessions_session ON debug_sessions(session_id);

-- State snapshots captured at each step
CREATE TABLE IF NOT EXISTS debug_snapshots (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  debug_session_id UUID NOT NULL REFERENCES debug_sessions(id) ON DELETE CASCADE,
  turn          INT NOT NULL,
  phase         TEXT NOT NULL,
  -- Captured state
  system_prompt TEXT,                    -- full assembled system prompt
  messages      JSONB NOT NULL,          -- conversation history at this point
  tool_schemas  JSONB,                   -- tools available to the agent
  memory_context JSONB,                  -- memory retrievals
  inference_request JSONB,               -- what was sent to the LLM
  inference_response JSONB,              -- what the LLM returned
  tool_calls    JSONB,                   -- tool calls made
  tool_results  JSONB,                   -- tool results received
  token_usage   JSONB,                   -- token counts
  -- Metadata
  duration_ms   INT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_debug_snapshots_session ON debug_snapshots(debug_session_id);
CREATE INDEX IF NOT EXISTS idx_debug_snapshots_turn ON debug_snapshots(debug_session_id, turn, phase);
