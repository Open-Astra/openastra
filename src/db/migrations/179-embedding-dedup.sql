-- Index to speed up the SHA-256 dedup check in embedding_cache
-- The text_hash column likely already has a UNIQUE constraint from migration 024,
-- but this ensures the index exists and is optimized for the dedup lookup pattern.

CREATE INDEX IF NOT EXISTS idx_embedding_cache_text_hash
  ON embedding_cache (text_hash);

-- Track dedup hit count per entry for analytics
ALTER TABLE embedding_cache
  ADD COLUMN IF NOT EXISTS dedup_hit_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ;

-- Function to atomically record a dedup hit
CREATE OR REPLACE FUNCTION record_embedding_dedup_hit(p_hash TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  UPDATE embedding_cache
  SET dedup_hit_count = dedup_hit_count + 1,
      last_accessed_at = NOW()
  WHERE text_hash = p_hash;
END;
$$;
