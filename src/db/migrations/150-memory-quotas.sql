CREATE TABLE IF NOT EXISTS memory_quotas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  agent_id TEXT,
  tier TEXT NOT NULL CHECK (tier IN ('daily', 'profile', 'graph', 'procedural', 'all')),
  max_entries INT,
  max_storage_bytes BIGINT,
  overflow_policy TEXT NOT NULL DEFAULT 'evict_oldest' CHECK (overflow_policy IN ('evict_oldest', 'evict_lowest_impact', 'block_writes', 'compress')),
  warning_threshold_pct INT NOT NULL DEFAULT 80,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_quotas_unique
  ON memory_quotas(workspace_id, COALESCE(agent_id, '__workspace__'), tier);

CREATE INDEX IF NOT EXISTS idx_memory_quotas_ws ON memory_quotas(workspace_id);

CREATE TABLE IF NOT EXISTS memory_quota_usage (
  workspace_id TEXT NOT NULL,
  agent_id TEXT,
  tier TEXT NOT NULL,
  current_entries INT NOT NULL DEFAULT 0,
  current_bytes BIGINT NOT NULL DEFAULT 0,
  last_enforced_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_quota_usage_pk
  ON memory_quota_usage(workspace_id, COALESCE(agent_id, '__workspace__'), tier);
