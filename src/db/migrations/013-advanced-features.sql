-- 013: Advanced Features
-- Tables for: swarm planner, approval workflows, optimizer, quotas, debate,
-- agent cloning/versioning, RAG documents, memory summarization,
-- cross-workspace sharing, persona evolution, dream mode, deep research.

-- ── Swarm Plans ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS swarm_plans (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL,
  strategy    TEXT NOT NULL DEFAULT 'adaptive',
  plan        JSONB NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_swarm_plans_user ON swarm_plans(user_id, created_at DESC);

-- ── Approval Requests ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS approval_requests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  session_id  TEXT,
  action      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  config      JSONB NOT NULL DEFAULT '{}',
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  reason      TEXT,
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_uid ON approval_requests(user_id, status);
CREATE INDEX IF NOT EXISTS idx_approval_requests_pending ON approval_requests(status) WHERE status = 'pending';

-- ── Optimizer Experiments ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS optimizer_experiments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uid         TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  type        TEXT NOT NULL,
  config      JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_optimizer_experiments_agent ON optimizer_experiments(agent_id, created_at DESC);

-- ── Quota Usage ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS quota_usage (
  agent_id          TEXT PRIMARY KEY,
  tokens_hour       BIGINT NOT NULL DEFAULT 0,
  tokens_day        BIGINT NOT NULL DEFAULT 0,
  tokens_month      BIGINT NOT NULL DEFAULT 0,
  requests_minute   INTEGER NOT NULL DEFAULT 0,
  requests_hour     INTEGER NOT NULL DEFAULT 0,
  requests_day      INTEGER NOT NULL DEFAULT 0,
  spawns_day        INTEGER NOT NULL DEFAULT 0,
  active_spawns     INTEGER NOT NULL DEFAULT 0,
  active_sessions   INTEGER NOT NULL DEFAULT 0,
  cost_day_cents    INTEGER NOT NULL DEFAULT 0,
  cost_month_cents  INTEGER NOT NULL DEFAULT 0,
  last_reset_hour   TEXT NOT NULL DEFAULT '',
  last_reset_day    TEXT NOT NULL DEFAULT '',
  last_reset_month  TEXT NOT NULL DEFAULT '',
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS quota_configs (
  agent_id        TEXT PRIMARY KEY,
  config          JSONB NOT NULL DEFAULT '{}',
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Debate Records ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS debate_records (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  swarm_id    TEXT,
  conflict_id TEXT,
  user_id     TEXT,
  config      JSONB NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_debate_records_swarm ON debate_records(swarm_id);

-- ── Agent Versions ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_versions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    TEXT NOT NULL,
  version     INTEGER NOT NULL,
  config      JSONB NOT NULL DEFAULT '{}',
  changelog   TEXT,
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (agent_id, version)
);

CREATE INDEX IF NOT EXISTS idx_agent_versions_agent ON agent_versions(agent_id, version DESC);

-- ── Agent Lineage ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_lineage (
  agent_id    TEXT PRIMARY KEY,
  parent_id   TEXT NOT NULL,
  fork_point  INTEGER,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_lineage_parent ON agent_lineage(parent_id);

-- ── Documents (RAG) ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS documents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uid         TEXT NOT NULL,
  filename    TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'text',
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_documents_uid ON documents(uid, created_at DESC);

CREATE TABLE IF NOT EXISTS document_chunks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  uid         TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content     TEXT NOT NULL,
  embedding   vector(768),
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_document_chunks_doc ON document_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_document_chunks_uid ON document_chunks(uid);

-- HNSW index for document chunk embeddings
CREATE INDEX IF NOT EXISTS idx_document_chunks_embedding ON document_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ── Memory Summaries ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS memory_summaries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uid         TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'daily',
  period      TEXT NOT NULL,
  summary     TEXT NOT NULL,
  themes      TEXT[] NOT NULL DEFAULT '{}',
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_summaries_uid ON memory_summaries(uid, type, created_at DESC);

-- ── Memory Shares (Cross-Workspace) ─────────────────────────────────

CREATE TABLE IF NOT EXISTS memory_shares (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_uid       TEXT NOT NULL,
  target_uid      TEXT NOT NULL,
  segments        TEXT[] NOT NULL DEFAULT '{}',
  permissions     TEXT[] NOT NULL DEFAULT '{read}',
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_shares_owner ON memory_shares(owner_uid);
CREATE INDEX IF NOT EXISTS idx_memory_shares_target ON memory_shares(target_uid);

-- ── Persona Evolutions ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS persona_evolutions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    TEXT NOT NULL,
  config      JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_persona_evolutions_agent ON persona_evolutions(agent_id, created_at DESC);

-- ── Dream Sessions ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dream_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uid         TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  config      JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dream_sessions_uid ON dream_sessions(uid, created_at DESC);

CREATE TABLE IF NOT EXISTS user_dream_configs (
  uid         TEXT PRIMARY KEY,
  config      JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Research Tasks ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS research_tasks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uid         TEXT NOT NULL,
  topic       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'planning',
  config      JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_research_tasks_uid ON research_tasks(uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_tasks_status ON research_tasks(status) WHERE status IN ('planning', 'researching');

-- ── HNSW Index Tuning per Memory Tier ────────────────────────────────

-- Tier 1 (Ephemeral / session chunks): fast writes, moderate recall
-- Lower m = faster inserts for high-frequency session messages
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_memory_chunks_embedding') THEN
    DROP INDEX idx_memory_chunks_embedding;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'memory_chunks') THEN
    CREATE INDEX IF NOT EXISTS idx_memory_chunks_hnsw ON memory_chunks
      USING hnsw (embedding vector_cosine_ops)
      WITH (m = 8, ef_construction = 32);
  END IF;
END $$;

-- Tier 4 (Graph entities): infrequent writes, maximum recall
-- Higher m+ef = best possible recall for precious knowledge nodes
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_graph_entities_embedding') THEN
    DROP INDEX idx_graph_entities_embedding;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'graph_entities') THEN
    CREATE INDEX IF NOT EXISTS idx_graph_entities_hnsw ON graph_entities
      USING hnsw (embedding vector_cosine_ops)
      WITH (m = 24, ef_construction = 128);
  END IF;
END $$;

-- Migration tracking handled by the runner (migrate.ts)
