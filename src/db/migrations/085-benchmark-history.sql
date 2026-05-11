-- Migration 085: Inference benchmark history
-- Stores the results of cross-provider benchmark runs.

CREATE TABLE IF NOT EXISTS inference_benchmarks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  run_by       TEXT,
  config       JSONB NOT NULL,
  results      JSONB NOT NULL,
  ran_at       TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_benchmarks_workspace ON inference_benchmarks(workspace_id, ran_at DESC);
