-- Migration 169: Semantic Tool Cache
-- Stores tool results for semantic similarity lookup.

CREATE TABLE IF NOT EXISTS semantic_tool_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_name TEXT NOT NULL,
  query_text TEXT NOT NULL,
  query_hash TEXT NOT NULL UNIQUE,
  result JSONB NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_hit_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_semantic_tool_cache_tool
  ON semantic_tool_cache (tool_name, expires_at);

CREATE INDEX IF NOT EXISTS idx_semantic_tool_cache_hash
  ON semantic_tool_cache (query_hash);
