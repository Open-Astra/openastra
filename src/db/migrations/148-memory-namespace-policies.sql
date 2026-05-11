CREATE TABLE IF NOT EXISTS memory_namespace_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  isolation_level TEXT NOT NULL CHECK (isolation_level IN ('strict', 'shared_read', 'shared_write', 'open')) DEFAULT 'strict',
  max_entries INT,
  max_storage_bytes BIGINT,
  allowed_tiers TEXT[] NOT NULL DEFAULT '{daily,profile,graph,procedural}',
  allowed_agents TEXT[] NOT NULL DEFAULT '{}',
  ttl_days INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, namespace)
);

CREATE INDEX IF NOT EXISTS idx_ns_policies_ws ON memory_namespace_policies(workspace_id);

CREATE TABLE IF NOT EXISTS memory_namespace_usage (
  workspace_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  entry_count INT NOT NULL DEFAULT 0,
  storage_bytes BIGINT NOT NULL DEFAULT 0,
  last_write_at TIMESTAMPTZ,
  last_read_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id, namespace)
);
