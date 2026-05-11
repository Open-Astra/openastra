-- Add tags support to semantic cache for fine-grained invalidation
ALTER TABLE semantic_cache ADD COLUMN tags text[] NOT NULL DEFAULT '{}';

-- Index for efficient tag-based filtering
CREATE INDEX idx_semantic_cache_tags ON semantic_cache USING GIN(tags);
