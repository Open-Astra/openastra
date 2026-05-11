-- ── Team Features ──────────────────────────────────────────────────
-- Workspace-scoped memory, knowledge, codebase index, diagnostics, costs.

-- ── Workspace Memory ───────────────────────────────────────────────
-- Team-scoped memory entries with embeddings and categories.
CREATE TABLE IF NOT EXISTS workspace_memory (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  author_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category      TEXT NOT NULL DEFAULT 'note'
                CHECK (category IN ('decision', 'adr', 'standup', 'retrospective', 'note', 'knowledge')),
  content       TEXT NOT NULL,
  tags          TEXT[] NOT NULL DEFAULT '{}',
  embedding     vector(768),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspace_memory_ws ON workspace_memory(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_memory_category ON workspace_memory(workspace_id, category);
CREATE INDEX IF NOT EXISTS idx_workspace_memory_tags ON workspace_memory USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_workspace_memory_embedding ON workspace_memory
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- ── Workspace Knowledge Base ───────────────────────────────────────
-- Structured knowledge entries (ADRs, standards, runbooks, etc.)
CREATE TABLE IF NOT EXISTS workspace_knowledge (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  author_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          TEXT NOT NULL DEFAULT 'note'
                CHECK (type IN ('adr', 'standard', 'runbook', 'faq', 'glossary')),
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'deprecated', 'superseded')),
  superseded_by UUID REFERENCES workspace_knowledge(id),
  tags          TEXT[] NOT NULL DEFAULT '{}',
  embedding     vector(768),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspace_knowledge_ws ON workspace_knowledge(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_knowledge_type ON workspace_knowledge(workspace_id, type);
CREATE INDEX IF NOT EXISTS idx_workspace_knowledge_status ON workspace_knowledge(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_workspace_knowledge_tags ON workspace_knowledge USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_workspace_knowledge_embedding ON workspace_knowledge
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- ── Codebase Index ─────────────────────────────────────────────────
-- Indexed source files with extracted symbols and embeddings.
CREATE TABLE IF NOT EXISTS codebase_index (
  id            BIGSERIAL PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  language      TEXT NOT NULL,
  symbols       JSONB NOT NULL DEFAULT '[]',
  content_hash  TEXT NOT NULL,
  snippet       TEXT NOT NULL DEFAULT '',
  embedding     vector(768),
  indexed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, file_path)
);

CREATE INDEX IF NOT EXISTS idx_codebase_index_ws ON codebase_index(workspace_id);
CREATE INDEX IF NOT EXISTS idx_codebase_index_lang ON codebase_index(workspace_id, language);
CREATE INDEX IF NOT EXISTS idx_codebase_index_symbols ON codebase_index USING GIN(symbols);
CREATE INDEX IF NOT EXISTS idx_codebase_index_embedding ON codebase_index
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- ── Diagnostic Runs ────────────────────────────────────────────────
-- History of diagnostic checks (astra doctor).
CREATE TABLE IF NOT EXISTS diagnostic_runs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status      TEXT NOT NULL DEFAULT 'unknown'
              CHECK (status IN ('healthy', 'degraded', 'unhealthy', 'unknown')),
  results     JSONB NOT NULL DEFAULT '{}',
  duration_ms INTEGER,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Cost Snapshots ─────────────────────────────────────────────────
-- Aggregated cost data by period for the cost dashboard.
CREATE TABLE IF NOT EXISTS cost_snapshots (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  period        TEXT NOT NULL,                  -- YYYY-MM-DD or YYYY-MM
  total_tokens  BIGINT NOT NULL DEFAULT 0,
  total_cost    NUMERIC(12,4) NOT NULL DEFAULT 0,
  by_agent      JSONB NOT NULL DEFAULT '{}',
  by_user       JSONB NOT NULL DEFAULT '{}',
  by_model      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (workspace_id, period)
);

CREATE INDEX IF NOT EXISTS idx_cost_snapshots_ws ON cost_snapshots(workspace_id, period);

-- ── Message Embeddings ─────────────────────────────────────────────
-- Add embedding column to messages for smart context selection.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS embedding vector(768);
CREATE INDEX IF NOT EXISTS idx_messages_embedding ON messages
  USING hnsw (embedding vector_cosine_ops) WITH (m = 8, ef_construction = 32);
