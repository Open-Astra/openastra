-- ── Feature 1: Session-level Request Coalescing ────────────────────
-- Track in-flight requests per session to deduplicate identical concurrent calls
CREATE TABLE IF NOT EXISTS coalesced_requests (
  request_hash TEXT NOT NULL,
  uid TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  message_hash TEXT NOT NULL,
  surface TEXT NOT NULL,
  surface_id TEXT NOT NULL,
  response_json JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (request_hash, created_at)
);
CREATE INDEX IF NOT EXISTS idx_coalesced_active
  ON coalesced_requests (uid, agent_id, created_at)
  WHERE created_at > NOW() - INTERVAL '10 seconds';

-- ── Feature 2: Token Budget Prediction ──────────────────────────────
-- Historical token usage for accurate budget prediction
CREATE TABLE IF NOT EXISTS token_estimates (
  agent_id TEXT NOT NULL,
  model TEXT NOT NULL,
  message_length_tokens INT NOT NULL,
  prompt_tokens INT NOT NULL,
  completion_tokens INT NOT NULL,
  total_tokens INT NOT NULL,
  recorded_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (agent_id, model, recorded_at)
);
CREATE INDEX IF NOT EXISTS idx_token_estimates_lookup
  ON token_estimates (agent_id, model, recorded_at DESC);

-- ── Feature 3: Hierarchical Cache Invalidation ──────────────────────
-- Parent-child relationships for cascade invalidation
CREATE TABLE IF NOT EXISTS cache_hierarchy (
  cache_id UUID PRIMARY KEY,
  hierarchy_parent_id UUID REFERENCES cache_hierarchy(cache_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cache_hierarchy_parent
  ON cache_hierarchy (hierarchy_parent_id);

-- ── Feature 4: ML-Driven Cache Warming ──────────────────────────────
-- Track query access patterns for predictive warming
CREATE TABLE IF NOT EXISTS cache_access_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uid TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  query_text TEXT NOT NULL,
  frequency INT NOT NULL DEFAULT 1,
  last_accessed_at TIMESTAMPTZ DEFAULT NOW(),
  predictive_score FLOAT NOT NULL DEFAULT 0.0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cache_access_patterns_lookup
  ON cache_access_patterns (agent_id, predictive_score DESC);
CREATE INDEX IF NOT EXISTS idx_cache_access_patterns_user_agent
  ON cache_access_patterns (uid, agent_id);

-- ── Feature 5: Schema-Aware Query Deduplication ──────────────────────
-- Detect semantic groups of queries with the same structure
CREATE TABLE IF NOT EXISTS query_schemas (
  schema_hash TEXT PRIMARY KEY,
  semantic_group UUID NOT NULL DEFAULT gen_random_uuid(),
  query_example TEXT NOT NULL,
  normalized_query TEXT NOT NULL,
  query_type TEXT NOT NULL, -- 'sql' | 'graphql' | 'other'
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_query_schemas_semantic_group
  ON query_schemas (semantic_group);

-- ── Feature 6: Adaptive Batch Sizing ────────────────────────────────
-- Track batch sizing metrics for optimization
CREATE TABLE IF NOT EXISTS batch_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  batch_size INT NOT NULL,
  latency_ms INT NOT NULL,
  error BOOLEAN NOT NULL DEFAULT FALSE,
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_batch_metrics_lookup
  ON batch_metrics (agent_id, workspace_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_batch_metrics_recent
  ON batch_metrics (agent_id, recorded_at DESC)
  WHERE recorded_at > NOW() - INTERVAL '1 hour';
