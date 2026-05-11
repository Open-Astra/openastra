-- Migration 142: Memory Contradiction Detection
CREATE TABLE IF NOT EXISTS memory_contradictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  memory_id_a TEXT NOT NULL,
  memory_id_b TEXT NOT NULL,
  tier_a TEXT NOT NULL,
  tier_b TEXT NOT NULL,
  content_a TEXT NOT NULL,
  content_b TEXT NOT NULL,
  contradiction_type TEXT NOT NULL CHECK (contradiction_type IN ('factual', 'preference', 'temporal', 'behavioral')),
  confidence REAL NOT NULL DEFAULT 0,
  resolution TEXT CHECK (resolution IN ('keep_a', 'keep_b', 'merge', 'dismiss', 'pending')),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contradictions_ws ON memory_contradictions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_contradictions_pending ON memory_contradictions(workspace_id) WHERE resolution = 'pending' OR resolution IS NULL;
