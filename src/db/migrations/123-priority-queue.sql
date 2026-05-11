CREATE TABLE IF NOT EXISTS priority_queue_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT,
  priority INT NOT NULL,
  wait_ms INT NOT NULL,
  rejected BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pq_metrics_ws ON priority_queue_metrics (workspace_id, created_at DESC);
