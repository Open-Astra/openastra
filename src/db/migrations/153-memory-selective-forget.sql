CREATE TABLE IF NOT EXISTS memory_forget_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  forget_scope TEXT NOT NULL CHECK (forget_scope IN ('topic', 'entity', 'time_range', 'agent', 'category', 'custom_query')),
  scope_value TEXT NOT NULL,
  tiers_affected TEXT[] NOT NULL DEFAULT '{daily,profile,graph,procedural}',
  status TEXT NOT NULL CHECK (status IN ('pending', 'preview', 'approved', 'executing', 'completed', 'cancelled')) DEFAULT 'pending',
  entries_found INT NOT NULL DEFAULT 0,
  entries_deleted INT NOT NULL DEFAULT 0,
  preview_data JSONB,
  audit_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  executed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_forget_requests_ws ON memory_forget_requests(workspace_id);
CREATE INDEX IF NOT EXISTS idx_forget_requests_status ON memory_forget_requests(status) WHERE status NOT IN ('completed', 'cancelled');
