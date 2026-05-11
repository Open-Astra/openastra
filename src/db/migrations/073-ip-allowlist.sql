CREATE TABLE IF NOT EXISTS workspace_ip_allowlists (
  workspace_id UUID PRIMARY KEY,
  allowed_cidrs TEXT[] NOT NULL DEFAULT '{}',
  enabled BOOLEAN DEFAULT true,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
