CREATE TABLE IF NOT EXISTS swarm_telemetry_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  swarm_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'swarm_started','swarm_completed','swarm_failed',
    'agent_joined','agent_left','agent_throttled','agent_terminated',
    'message_sent','message_received',
    'tool_dispatched','tool_completed','tool_failed',
    'decision_made','conflict_detected','consensus_reached',
    'checkpoint_created','budget_warning','budget_exhausted'
  )),
  agent_id TEXT,
  target_agent_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}',
  emitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_swarm_telemetry_ws ON swarm_telemetry_events(workspace_id, swarm_id, emitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_swarm_telemetry_type ON swarm_telemetry_events(workspace_id, event_type);
CREATE TABLE IF NOT EXISTS swarm_topology_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  swarm_id TEXT NOT NULL,
  nodes JSONB NOT NULL DEFAULT '[]',
  edges JSONB NOT NULL DEFAULT '[]',
  agent_states JSONB NOT NULL DEFAULT '{}',
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_swarm_topology_ws ON swarm_topology_snapshots(workspace_id, swarm_id, snapshot_at DESC);