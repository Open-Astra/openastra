DROP TABLE IF EXISTS memory_summaries CASCADE;
CREATE TABLE memory_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('daily', 'weekly', 'monthly', 'quarterly')),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  summary TEXT NOT NULL,
  key_decisions TEXT[] NOT NULL DEFAULT '{}',
  key_outcomes TEXT[] NOT NULL DEFAULT '{}',
  entry_count INT NOT NULL DEFAULT 0,
  source_summary_ids UUID[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, level, period_start)
);

CREATE INDEX IF NOT EXISTS idx_summaries_ws_level ON memory_summaries(workspace_id, level, period_start DESC);
