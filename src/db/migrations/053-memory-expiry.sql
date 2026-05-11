CREATE TABLE IF NOT EXISTS memory_expiry_policies (
  workspace_id UUID PRIMARY KEY,
  rules JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
