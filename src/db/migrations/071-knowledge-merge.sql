-- Migration 071: Cross-Workspace Knowledge Merge
-- Tracks requests to merge graph entities from one workspace into another

CREATE TABLE IF NOT EXISTS knowledge_merge_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_workspace_id UUID NOT NULL,
  target_workspace_id UUID NOT NULL,
  uid TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  merge_type TEXT DEFAULT 'graph_entities',
  filters JSONB DEFAULT '{}',
  merged_count INT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_knowledge_merge_requests_uid
  ON knowledge_merge_requests(uid, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_knowledge_merge_requests_status
  ON knowledge_merge_requests(status, created_at DESC);
