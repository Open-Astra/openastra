-- ── Graph Memory Schema ──────────────────────────────────────────────
-- Cloud SQL PostgreSQL 15 + pgvector
-- Stores entity graph for the agent memory layer.

-- Enable pgvector extension (must be done by superuser / Cloud SQL supports it)
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Entities (Nodes) ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS graph_entities (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  uid         TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN (
                'person', 'team', 'event', 'concept', 'market', 'outcome', 'document'
              )),
  name        TEXT NOT NULL,
  description TEXT DEFAULT '',
  properties  JSONB DEFAULT '{}',
  embedding   vector(768),

  -- Temporal / reinforcement
  reinforcement_score FLOAT DEFAULT 1.0,
  access_count        INT DEFAULT 0,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  last_accessed_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for entity lookups
CREATE INDEX IF NOT EXISTS idx_entities_uid ON graph_entities(uid);
CREATE INDEX IF NOT EXISTS idx_entities_uid_type ON graph_entities(uid, type);
CREATE INDEX IF NOT EXISTS idx_entities_uid_name ON graph_entities(uid, name);
CREATE INDEX IF NOT EXISTS idx_entities_last_accessed ON graph_entities(uid, last_accessed_at DESC);

-- pgvector index for semantic search (IVFFlat — good up to ~1M rows)
CREATE INDEX IF NOT EXISTS idx_entities_embedding ON graph_entities
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ── Edges (Relationships) ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS graph_edges (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  uid                 TEXT NOT NULL,
  source_id           UUID NOT NULL REFERENCES graph_entities(id) ON DELETE CASCADE,
  target_id           UUID NOT NULL REFERENCES graph_entities(id) ON DELETE CASCADE,
  type                TEXT NOT NULL CHECK (type IN (
                        'plays_for', 'related_to', 'caused_by', 'contradicts',
                        'supports', 'part_of', 'preceded_by', 'correlated_with',
                        'mentioned_in', 'user_noted'
                      )),
  weight              FLOAT DEFAULT 0.5 CHECK (weight >= 0 AND weight <= 1),
  metadata            JSONB DEFAULT '{}',

  -- Temporal
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  last_reinforced_at  TIMESTAMPTZ DEFAULT NOW(),
  reinforcement_count INT DEFAULT 1,

  -- Prevent duplicate edges of the same type between same nodes
  UNIQUE (uid, source_id, target_id, type)
);

-- Indexes for edge traversal
CREATE INDEX IF NOT EXISTS idx_edges_uid ON graph_edges(uid);
CREATE INDEX IF NOT EXISTS idx_edges_source ON graph_edges(uid, source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON graph_edges(uid, target_id);
CREATE INDEX IF NOT EXISTS idx_edges_type ON graph_edges(uid, type);

-- ── Migration tracking ──────────────────────────────────────────────
-- schema_migrations is created by the main migration runner (001-schema-migrations.sql)
-- with schema (version TEXT PK, applied_at TIMESTAMPTZ). Just insert our marker.

INSERT INTO schema_migrations (version, applied_at)
VALUES ('graph-001', NOW())
ON CONFLICT (version) DO NOTHING;
