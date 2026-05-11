-- Migration 189: Response streaming cache coordination
-- Coordinates cached responses with streaming delivery
-- Tracks cache hit offsets to enable seamless stream replay from cache

CREATE TABLE stream_cache_hints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text NOT NULL,
  request_hash text NOT NULL,
  cached_response_start int,
  cached_response_length int,
  stream_started_at timestamptz,
  cache_hit_at timestamptz,
  UNIQUE(session_id, request_hash)
);

CREATE INDEX idx_stream_cache_hints_session ON stream_cache_hints(session_id);
CREATE INDEX idx_stream_cache_hints_request_hash ON stream_cache_hints(request_hash);
CREATE INDEX idx_stream_cache_hints_hit_time ON stream_cache_hints(cache_hit_at DESC);
