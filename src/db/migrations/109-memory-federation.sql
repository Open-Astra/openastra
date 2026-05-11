-- 109: Memory federation across Astra nodes/regions
CREATE TABLE IF NOT EXISTS federation_nodes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  node_url     TEXT NOT NULL,
  node_name    TEXT NOT NULL,
  api_key_hash TEXT NOT NULL,   -- SHA-256 of API key for verification
  sync_enabled BOOLEAN NOT NULL DEFAULT true,
  last_seen_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, node_url)
);

CREATE TABLE IF NOT EXISTS federation_sync_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  node_id      UUID NOT NULL REFERENCES federation_nodes(id) ON DELETE CASCADE,
  direction    TEXT NOT NULL,   -- 'push' | 'pull'
  records_sent INT NOT NULL DEFAULT 0,
  records_recv INT NOT NULL DEFAULT 0,
  status       TEXT NOT NULL,   -- 'ok' | 'error'
  error        TEXT,
  synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_federation_nodes_ws ON federation_nodes (workspace_id);
CREATE INDEX IF NOT EXISTS idx_federation_sync_node ON federation_sync_log (node_id, synced_at DESC);
