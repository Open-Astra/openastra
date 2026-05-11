-- 111: Per-category structured memory schemas
CREATE TABLE IF NOT EXISTS memory_schemas (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  category     TEXT NOT NULL,   -- 'decision' | 'outcome' | 'strategy' | 'note' | 'interaction' | custom
  json_schema  JSONB NOT NULL,  -- JSON Schema for metadata field validation
  strict       BOOLEAN NOT NULL DEFAULT false,  -- if true, reject writes that fail validation
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, category)
);
CREATE INDEX IF NOT EXISTS idx_memory_schemas_ws ON memory_schemas (workspace_id, category);
