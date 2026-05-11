CREATE TABLE IF NOT EXISTS otel_export_configs (
  workspace_id UUID PRIMARY KEY,
  endpoint TEXT NOT NULL,
  headers JSONB DEFAULT '{}',
  enabled BOOLEAN DEFAULT true,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
