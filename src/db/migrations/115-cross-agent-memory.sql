-- Feature 24: Cross-Agent Memory Sharing
CREATE TABLE IF NOT EXISTS shared_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_agent_id TEXT NOT NULL,
  target_agent_id TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  shared_by TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shared_memories_target ON shared_memories(target_agent_id);
CREATE INDEX IF NOT EXISTS idx_shared_memories_source ON shared_memories(source_agent_id);
