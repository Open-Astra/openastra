-- Migration 141: Memory Compaction Policies
CREATE TABLE IF NOT EXISTS memory_compaction_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  agent_id TEXT,
  strategy TEXT NOT NULL CHECK (strategy IN ('sliding_window', 'importance_weighted', 'topic_clustered', 'hybrid')),
  config JSONB NOT NULL DEFAULT '{}',
  max_entries INT NOT NULL DEFAULT 500,
  retention_days INT NOT NULL DEFAULT 90,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_compaction_policies_ws ON memory_compaction_policies(workspace_id);
CREATE INDEX IF NOT EXISTS idx_compaction_policies_agent ON memory_compaction_policies(workspace_id, agent_id);

CREATE TABLE IF NOT EXISTS memory_compaction_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id UUID NOT NULL REFERENCES memory_compaction_policies(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  entries_before INT NOT NULL DEFAULT 0,
  entries_after INT NOT NULL DEFAULT 0,
  bytes_freed BIGINT NOT NULL DEFAULT 0,
  strategy TEXT NOT NULL,
  duration_ms INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')) DEFAULT 'running',
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
