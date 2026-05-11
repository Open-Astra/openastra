-- Migration 143: Memory Provenance Chain Tracking
CREATE TABLE IF NOT EXISTS memory_provenance_chain (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  memory_tier TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('session', 'tool_output', 'agent_write', 'user_input', 'system', 'compaction', 'merge', 'import')),
  source_session_id TEXT,
  source_agent_id TEXT,
  source_tool_name TEXT,
  source_user_id TEXT,
  parent_provenance_id UUID REFERENCES memory_provenance_chain(id),
  trust_score REAL NOT NULL DEFAULT 1.0,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_provenance_chain_memory ON memory_provenance_chain(workspace_id, memory_id);
CREATE INDEX IF NOT EXISTS idx_provenance_chain_session ON memory_provenance_chain(source_session_id);
CREATE INDEX IF NOT EXISTS idx_provenance_chain_agent ON memory_provenance_chain(source_agent_id);
