CREATE TABLE IF NOT EXISTS memory_compression_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  agent_id TEXT,
  session_id TEXT,
  tokens_injected INT NOT NULL DEFAULT 0,
  tokens_influenced INT NOT NULL DEFAULT 0,
  memories_retrieved INT NOT NULL DEFAULT 0,
  memories_used INT NOT NULL DEFAULT 0,
  context_window_total INT NOT NULL DEFAULT 0,
  memory_token_ratio REAL NOT NULL DEFAULT 0,
  compression_ratio REAL NOT NULL DEFAULT 0,
  measured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_compression_metrics_ws ON memory_compression_metrics(workspace_id, measured_at DESC);
CREATE INDEX IF NOT EXISTS idx_compression_metrics_agent ON memory_compression_metrics(workspace_id, agent_id, measured_at DESC);

CREATE TABLE IF NOT EXISTS memory_retrieval_efficiency (
  workspace_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  total_retrieved INT NOT NULL DEFAULT 0,
  total_used INT NOT NULL DEFAULT 0,
  avg_position REAL,
  efficiency_ratio REAL NOT NULL DEFAULT 0,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id, tier, period_start)
);
