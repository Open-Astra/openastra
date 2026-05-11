-- Records provider-side prompt cache hit rates per inference call.
-- Used by the dashboard to show cache ROI and savings over time.

CREATE TABLE IF NOT EXISTS provider_cache_metrics (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  agent_id TEXT,
  workspace_id TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  hit_rate FLOAT GENERATED ALWAYS AS (
    CASE WHEN prompt_tokens > 0
      THEN cached_tokens::float / prompt_tokens
      ELSE 0
    END
  ) STORED,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_provider_cache_metrics_provider ON provider_cache_metrics (provider, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_provider_cache_metrics_agent ON provider_cache_metrics (agent_id, recorded_at DESC);

-- Auto-partition by month to keep the table lean (optional, just an index for now)
CREATE INDEX IF NOT EXISTS idx_provider_cache_metrics_time ON provider_cache_metrics (recorded_at DESC);
