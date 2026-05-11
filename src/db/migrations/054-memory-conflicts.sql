CREATE TABLE IF NOT EXISTS memory_conflicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  uid TEXT NOT NULL,
  fact_a TEXT NOT NULL,
  fact_b TEXT NOT NULL,
  source_a TEXT NOT NULL DEFAULT '',
  source_b TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  resolution TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_memory_conflicts_workspace ON memory_conflicts(workspace_id, uid, status);
