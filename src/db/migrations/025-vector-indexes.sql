-- Optional IVFFlat indexes for large-scale deployments
-- These are created as separate named indexes alongside the existing HNSW indexes.

-- IVFFlat for session_messages (Tier 1 — high write volume)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'session_messages') THEN
    CREATE INDEX IF NOT EXISTS idx_session_messages_ivfflat
      ON session_messages USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 100);
  END IF;
END $$;

-- IVFFlat for graph_entities (Tier 4 — precision critical)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'graph_entities') THEN
    CREATE INDEX IF NOT EXISTS idx_graph_entities_ivfflat
      ON graph_entities USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 100);
  END IF;
END $$;

-- Halfvec quantization for storage savings on Tier 1 (session_messages)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'halfvec')
     AND EXISTS (SELECT 1 FROM pg_class WHERE relname = 'session_messages') THEN
    ALTER TABLE session_messages ADD COLUMN IF NOT EXISTS embedding_half halfvec(768);
    CREATE INDEX IF NOT EXISTS idx_session_messages_halfvec
      ON session_messages USING hnsw (embedding_half halfvec_cosine_ops)
      WITH (m = 8, ef_construction = 32);
  END IF;
END $$;
