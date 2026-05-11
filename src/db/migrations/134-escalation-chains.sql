CREATE TABLE IF NOT EXISTS escalation_chains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  levels JSONB NOT NULL,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS escalation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id UUID REFERENCES escalation_chains(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  context JSONB,
  current_level INT DEFAULT 0,
  status TEXT DEFAULT 'active' CHECK(status IN ('active','acknowledged','resolved','expired')),
  acknowledged_by TEXT,
  resolution TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_escalation_chains_ws ON escalation_chains (workspace_id, active);
CREATE INDEX IF NOT EXISTS idx_escalation_events_ws ON escalation_events (workspace_id, status);
