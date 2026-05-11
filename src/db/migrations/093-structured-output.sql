-- 093: Per-agent structured output schemas
CREATE TABLE IF NOT EXISTS structured_output_schemas (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  json_schema   JSONB NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  max_repair_attempts INT NOT NULL DEFAULT 2,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_structured_output_agent ON structured_output_schemas (agent_id, workspace_id);
