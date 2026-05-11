CREATE TABLE IF NOT EXISTS edge_cache_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT,
  cache_key TEXT NOT NULL UNIQUE,
  response_body TEXT NOT NULL,
  status_code INT NOT NULL,
  headers JSONB DEFAULT '{}',
  ttl_seconds INT DEFAULT 60,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_edge_cache_key ON edge_cache_entries (cache_key);
CREATE INDEX IF NOT EXISTS idx_edge_cache_ws ON edge_cache_entries (workspace_id);
CREATE INDEX IF NOT EXISTS idx_edge_cache_expires ON edge_cache_entries (expires_at);
