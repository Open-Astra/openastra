-- Load balancing: per-worker session tracking
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS worker_id TEXT;

CREATE TABLE IF NOT EXISTS agent_worker_stats (
  worker_id        TEXT NOT NULL,
  agent_id         TEXT NOT NULL,
  active_sessions  INT NOT NULL DEFAULT 0,
  last_heartbeat   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (worker_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_worker_stats_agent
  ON agent_worker_stats(agent_id, active_sessions);
