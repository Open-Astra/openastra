-- Long-running job queue
CREATE TABLE IF NOT EXISTS job_queue (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     TEXT NOT NULL,
  type             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  payload          JSONB NOT NULL,
  result           JSONB,
  error            TEXT,
  progress         INT NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  worker_id        TEXT,
  max_retries      INT NOT NULL DEFAULT 3,
  retry_count      INT NOT NULL DEFAULT 0,
  timeout_seconds  INT NOT NULL DEFAULT 300
);
CREATE INDEX IF NOT EXISTS idx_job_queue_status_created ON job_queue (status, created_at);
CREATE INDEX IF NOT EXISTS idx_job_queue_workspace_status ON job_queue (workspace_id, status);
