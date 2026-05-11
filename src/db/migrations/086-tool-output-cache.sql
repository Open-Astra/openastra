-- Migration 086: Tool output caching
-- Caches deterministic tool results to avoid re-execution.

CREATE TABLE IF NOT EXISTS tool_output_cache (
  cache_key  TEXT PRIMARY KEY,
  tool_name  TEXT NOT NULL,
  result     JSONB NOT NULL,
  hit_count  INT  NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_hit_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tool_cache_name    ON tool_output_cache(tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_cache_expires ON tool_output_cache(expires_at);

CREATE TABLE IF NOT EXISTS tool_cache_events (
  id          BIGSERIAL PRIMARY KEY,
  tool_name   TEXT NOT NULL,
  event_type  TEXT NOT NULL CHECK (event_type IN ('hit', 'miss')),
  recorded_at TIMESTAMPTZ DEFAULT now()
);
