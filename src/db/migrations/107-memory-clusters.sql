-- 107: Semantic clustering of daily memory entries
CREATE TABLE IF NOT EXISTS memory_clusters (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  label        TEXT NOT NULL,        -- cluster name (LLM-generated)
  centroid     vector(768),          -- mean embedding of cluster members
  size         INT NOT NULL DEFAULT 0,
  computed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS memory_cluster_members (
  cluster_id   UUID NOT NULL REFERENCES memory_clusters(id) ON DELETE CASCADE,
  memory_id    TEXT NOT NULL,
  distance     FLOAT,               -- distance from centroid
  PRIMARY KEY (cluster_id, memory_id)
);
CREATE INDEX IF NOT EXISTS idx_clusters_workspace ON memory_clusters (workspace_id, user_id, computed_at DESC);
