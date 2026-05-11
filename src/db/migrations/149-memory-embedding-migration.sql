CREATE TABLE IF NOT EXISTS embedding_migrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  source_model TEXT NOT NULL,
  target_model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'rolled_back')) DEFAULT 'pending',
  total_entries INT NOT NULL DEFAULT 0,
  migrated_entries INT NOT NULL DEFAULT 0,
  failed_entries INT NOT NULL DEFAULT 0,
  batch_size INT NOT NULL DEFAULT 100,
  error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_embed_migrations_ws ON embedding_migrations(workspace_id);
CREATE INDEX IF NOT EXISTS idx_embed_migrations_status ON embedding_migrations(status) WHERE status IN ('pending', 'running');
