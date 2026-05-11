CREATE TABLE IF NOT EXISTS memory_associations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  source_memory_id TEXT NOT NULL,
  source_tier TEXT NOT NULL,
  target_memory_id TEXT NOT NULL,
  target_tier TEXT NOT NULL,
  association_type TEXT NOT NULL CHECK (association_type IN ('related', 'derived', 'contradicts', 'supports', 'temporal_sequence', 'causal')),
  strength REAL NOT NULL DEFAULT 0.5,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, source_memory_id, target_memory_id)
);

CREATE INDEX IF NOT EXISTS idx_associations_source ON memory_associations(workspace_id, source_memory_id);
CREATE INDEX IF NOT EXISTS idx_associations_target ON memory_associations(workspace_id, target_memory_id);
CREATE INDEX IF NOT EXISTS idx_associations_type ON memory_associations(workspace_id, association_type);
