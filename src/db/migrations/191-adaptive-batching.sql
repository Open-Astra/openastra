-- Migration 191: Adaptive batch sizing metrics
-- Tracks performance characteristics of different batch sizes
-- Enables dynamic optimization of batching parameters for throughput and latency

CREATE TABLE batch_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL,
  workspace_id text,
  batch_size int,
  latency_ms int,
  throughput_rps numeric(8,2),
  error_rate numeric(5,2),
  timestamp timestamptz DEFAULT now(),
  UNIQUE(agent_id, batch_size, timestamp)
);

CREATE INDEX idx_batch_metrics_agent ON batch_metrics(agent_id);
CREATE INDEX idx_batch_metrics_agent_time ON batch_metrics(agent_id, timestamp DESC);
CREATE INDEX idx_batch_metrics_agent_size ON batch_metrics(agent_id, batch_size);
CREATE INDEX idx_batch_metrics_workspace ON batch_metrics(workspace_id);
