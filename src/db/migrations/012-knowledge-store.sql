-- 012: Persistent Knowledge Store
-- Durable key-value knowledge base with Typesense hybrid search

CREATE TABLE IF NOT EXISTS knowledge_store (
  id SERIAL PRIMARY KEY,
  uid TEXT NOT NULL,
  key TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(uid, key)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_store_uid ON knowledge_store(uid);
CREATE INDEX IF NOT EXISTS idx_knowledge_store_uid_key ON knowledge_store(uid, key);

-- Migration tracking handled by the runner (migrate.ts)
