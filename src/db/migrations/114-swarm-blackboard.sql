-- Feature 22: Persistent Swarm Blackboard
CREATE TABLE IF NOT EXISTS swarm_blackboard (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  swarm_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  written_by TEXT NOT NULL,
  version INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(swarm_id, key)
);
CREATE INDEX IF NOT EXISTS idx_blackboard_swarm ON swarm_blackboard(swarm_id);
