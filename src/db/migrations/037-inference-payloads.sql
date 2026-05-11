-- Inference payload audit table
-- Stores full request/response payloads for LLM API calls.
-- Separated from audit_log to keep the core audit table lean.
-- Rows expire based on configurable TTL (default 30 days).

CREATE TABLE IF NOT EXISTS inference_payloads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uid TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,

  -- Request side: full messages array sent to the provider (redacted)
  request_messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- System prompt hash (avoids storing the full prompt repeatedly)
  system_prompt_hash TEXT,
  -- Tool schemas sent (optional — large, mostly static)
  tool_schemas JSONB,

  -- Response side
  response_content TEXT,
  finish_reason TEXT,

  -- Token usage
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,

  -- Performance
  duration_ms INTEGER,
  trace_id TEXT,

  -- TTL
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days'
);

-- Query by user
CREATE INDEX IF NOT EXISTS idx_inference_payloads_uid ON inference_payloads (uid);

-- Query by session
CREATE INDEX IF NOT EXISTS idx_inference_payloads_session ON inference_payloads (session_id);

-- TTL cleanup
CREATE INDEX IF NOT EXISTS idx_inference_payloads_expires ON inference_payloads (expires_at)
  WHERE expires_at IS NOT NULL;

-- Time-range queries
CREATE INDEX IF NOT EXISTS idx_inference_payloads_created ON inference_payloads (created_at DESC);
