CREATE TABLE IF NOT EXISTS tenant_routing_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_id TEXT,
  region TEXT,
  endpoint_override TEXT,
  weight NUMERIC DEFAULT 1.0,
  priority INT DEFAULT 0,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(workspace_id, provider, model_id, region)
);

CREATE INDEX IF NOT EXISTS idx_tenant_routing_ws ON tenant_routing_rules (workspace_id);
