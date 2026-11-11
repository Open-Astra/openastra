-- 200: memory_chunks — pgvector fallback index for memory search.
-- Previously created lazily at runtime by src/memory/pg-search.ts.

CREATE TABLE IF NOT EXISTS memory_chunks (
  id SERIAL PRIMARY KEY,
  uid TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'daily',
  date TEXT,
  category TEXT,
  embedding vector(768),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_chunks_uid ON memory_chunks (uid);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_uid_created ON memory_chunks (uid, created_at DESC);

-- HNSW needs no training data (unlike ivfflat), so it is safe on an empty table.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema() AND tablename = 'memory_chunks'
      AND indexname IN ('idx_memory_chunks_embedding', 'idx_memory_chunks_embedding_hnsw')
  ) THEN
    CREATE INDEX idx_memory_chunks_embedding_hnsw
      ON memory_chunks USING hnsw (embedding vector_cosine_ops);
  END IF;
END $$;
