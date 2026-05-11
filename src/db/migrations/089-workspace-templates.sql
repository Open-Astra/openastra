-- Migration 089: Workspace templates
-- Snapshot a workspace config as a reusable template.

CREATE TABLE IF NOT EXISTS workspace_templates (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  snapshot     JSONB NOT NULL,
  created_by   TEXT,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspace_templates_ws ON workspace_templates(workspace_id);
