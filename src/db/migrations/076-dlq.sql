-- Migration 076: Dead Letter Queue
-- Stores failed jobs for inspection and replay

CREATE TABLE IF NOT EXISTS dead_letter_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID,
  job_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  error_message TEXT NOT NULL,
  attempts INT DEFAULT 1,
  original_job_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_attempted_at TIMESTAMPTZ DEFAULT NOW(),
  resolved BOOLEAN DEFAULT false,
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_dlq_workspace ON dead_letter_queue(workspace_id, resolved, created_at DESC);
