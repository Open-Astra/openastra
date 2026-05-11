-- Migration 190: Query schema normalization for deduplication
-- Enables semantic deduplication of queries with structurally equivalent patterns
-- Groups queries by schema for intelligent reuse across similar requests

CREATE TABLE query_schemas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query_text text NOT NULL,
  normalized_schema text NOT NULL,
  schema_hash text NOT NULL UNIQUE,
  semantic_group uuid,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_query_schemas_hash ON query_schemas(schema_hash);
CREATE INDEX idx_query_schemas_group ON query_schemas(semantic_group);
CREATE INDEX idx_query_schemas_created ON query_schemas(created_at DESC);
