-- Migration 187: Hierarchical cache relationships
-- Enables multi-level cache dependencies and invalidation patterns
-- Parent-child relationships allow cascade invalidation and coherence

ALTER TABLE semantic_cache ADD COLUMN hierarchy_parent_id uuid REFERENCES semantic_cache(id) ON DELETE SET NULL;
ALTER TABLE semantic_cache ADD COLUMN hierarchy_depth int DEFAULT 0;

CREATE INDEX idx_semantic_cache_parent ON semantic_cache(hierarchy_parent_id);
CREATE INDEX idx_semantic_cache_depth ON semantic_cache(hierarchy_depth);
CREATE INDEX idx_semantic_cache_parent_depth ON semantic_cache(hierarchy_parent_id, hierarchy_depth);
