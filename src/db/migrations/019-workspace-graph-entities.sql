CREATE TABLE IF NOT EXISTS workspace_graph_entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  properties JSONB NOT NULL DEFAULT '{}',
  embedding vector(768),
  reinforcement_score DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  access_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS workspace_graph_entities_workspace_id_idx ON workspace_graph_entities (workspace_id);
CREATE INDEX IF NOT EXISTS workspace_graph_entities_embedding_idx ON workspace_graph_entities USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64);
