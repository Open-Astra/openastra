-- Bootstrap: track which migrations have been applied
CREATE TABLE IF NOT EXISTS schema_migrations (
  version   TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable pgvector extension (required by memory/graph embedding columns)
CREATE EXTENSION IF NOT EXISTS vector;
