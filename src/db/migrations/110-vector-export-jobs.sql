-- 110: Vector DB export jobs (Pinecone / Weaviate / Qdrant)
CREATE TABLE IF NOT EXISTS vector_export_jobs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  target       TEXT NOT NULL,   -- 'pinecone' | 'weaviate' | 'qdrant'
  config       JSONB NOT NULL,  -- endpoint, index, namespace (no secrets — key via vault)
  tiers        TEXT[] NOT NULL DEFAULT '{daily,graph}',
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | failed
  records_exported INT NOT NULL DEFAULT 0,
  error        TEXT,
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vector_export_workspace ON vector_export_jobs (workspace_id, created_at DESC);
