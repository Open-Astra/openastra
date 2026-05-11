-- embedding_cache: SHA-256 keyed cache for generated embeddings
CREATE TABLE IF NOT EXISTS embedding_cache (
  text_hash TEXT PRIMARY KEY,
  text_preview TEXT NOT NULL,
  embedding vector(768) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
-- No index needed — text_hash is the PK (B-tree by default)

-- semantic_cache: stores past agent responses for semantic deduplication
CREATE TABLE IF NOT EXISTS semantic_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query_text TEXT NOT NULL,
  query_embedding vector(768) NOT NULL,
  content TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_semantic_cache_agent ON semantic_cache (agent_id, expires_at);
-- HNSW for fast cosine similarity search on query embeddings
CREATE INDEX IF NOT EXISTS idx_semantic_cache_embedding
  ON semantic_cache USING hnsw (query_embedding vector_cosine_ops)
  WITH (m = 8, ef_construction = 32);

-- Add expires_at to session_messages / daily_memory if they exist
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'session_messages') THEN
    ALTER TABLE session_messages ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_session_messages_expires ON session_messages (expires_at) WHERE expires_at IS NOT NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'daily_memory') THEN
    ALTER TABLE daily_memory ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_daily_memory_expires ON daily_memory (expires_at) WHERE expires_at IS NOT NULL;
  END IF;
END $$;
