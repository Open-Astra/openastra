-- Migration 090: Tool schema versioning
-- Tracks when a tool's parameter schema changes.

CREATE TABLE IF NOT EXISTS tool_schema_versions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_name   TEXT NOT NULL,
  version     INT  NOT NULL,
  schema      JSONB NOT NULL,
  schema_hash TEXT NOT NULL,
  registered_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (tool_name, version)
);

CREATE INDEX IF NOT EXISTS idx_tool_schema_versions_name ON tool_schema_versions(tool_name, version DESC);
