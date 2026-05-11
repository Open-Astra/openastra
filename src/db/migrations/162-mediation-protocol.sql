CREATE TABLE IF NOT EXISTS mediation_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  agent_a_id TEXT NOT NULL,
  agent_b_id TEXT NOT NULL,
  mediator_agent_id TEXT,
  dispute_context TEXT NOT NULL,
  agent_a_position TEXT,
  agent_b_position TEXT,
  mediator_analysis TEXT,
  resolution TEXT,
  resolution_type TEXT CHECK (resolution_type IN ('compromise','side_a','side_b','escalated','deadlocked')),
  status TEXT NOT NULL CHECK (status IN ('submitted','analyzing','mediating','resolved','escalated')) DEFAULT 'submitted',
  priority TEXT NOT NULL CHECK (priority IN ('low','medium','high','critical')) DEFAULT 'medium',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_mediation_ws ON mediation_sessions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_mediation_status ON mediation_sessions(workspace_id, status);
CREATE TABLE IF NOT EXISTS mediation_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES mediation_sessions(id) ON DELETE CASCADE,
  submitted_by TEXT NOT NULL,
  evidence_type TEXT NOT NULL CHECK (evidence_type IN ('output','reasoning','data','precedent')),
  content TEXT NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);