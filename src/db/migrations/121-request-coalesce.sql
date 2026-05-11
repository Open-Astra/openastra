CREATE TABLE IF NOT EXISTS request_coalesce_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT,
  hash TEXT NOT NULL,
  hit_count INT DEFAULT 1,
  first_seen TIMESTAMPTZ NOT NULL,
  last_seen TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coalesce_stats_ws ON request_coalesce_stats (workspace_id);
CREATE INDEX IF NOT EXISTS idx_coalesce_stats_hash ON request_coalesce_stats (hash);
