CREATE TABLE IF NOT EXISTS workspace_shared_context (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  key TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  priority INTEGER DEFAULT 0,
  added_by TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(workspace_id, key)
);
CREATE INDEX IF NOT EXISTS idx_shared_context_workspace ON workspace_shared_context(workspace_id, priority DESC);
