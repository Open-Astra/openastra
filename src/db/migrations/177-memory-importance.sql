-- Track memory access counts and last access time for Ebbinghaus-style importance scoring.
-- importance_score is recomputed by the memory doctor and used to prioritize TTL extension.

ALTER TABLE daily_notes
  ADD COLUMN IF NOT EXISTS access_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS importance_score FLOAT NOT NULL DEFAULT 0.5;

ALTER TABLE memory_entities
  ADD COLUMN IF NOT EXISTS access_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS importance_score FLOAT NOT NULL DEFAULT 0.5;

CREATE INDEX IF NOT EXISTS idx_daily_notes_importance ON daily_notes (uid, importance_score DESC);
CREATE INDEX IF NOT EXISTS idx_memory_entities_importance ON memory_entities (uid, importance_score DESC);
