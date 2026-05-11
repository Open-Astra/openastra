-- Migration 188: ML-driven cache warming patterns
-- Predicts which queries will be needed soon based on historical access patterns
-- Enables proactive cache population and latency reduction

CREATE TABLE cache_access_patterns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL,
  workspace_id text,
  query_embedding vector(1536),
  access_count int DEFAULT 1,
  access_timestamps timestamptz[] DEFAULT ARRAY[]::timestamptz[],
  predictive_score numeric(3,2) DEFAULT 0.00,
  created_at timestamptz DEFAULT now(),
  last_accessed_at timestamptz,
  UNIQUE(agent_id, query_embedding)
);

CREATE INDEX idx_cache_patterns_agent ON cache_access_patterns(agent_id);
CREATE INDEX idx_cache_patterns_agent_score ON cache_access_patterns(agent_id, predictive_score DESC);
CREATE INDEX idx_cache_patterns_last_access ON cache_access_patterns(agent_id, last_accessed_at DESC);
CREATE INDEX idx_cache_patterns_workspace ON cache_access_patterns(workspace_id);
