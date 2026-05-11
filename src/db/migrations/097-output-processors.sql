-- 097: Per-agent chainable output post-processors
CREATE TABLE IF NOT EXISTS output_processor_chains (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  position     INT NOT NULL DEFAULT 0,   -- execution order (ascending)
  processor    TEXT NOT NULL,            -- 'redact-pii' | 'reformat-json' | 'truncate' | 'translate' | 'custom'
  config       JSONB NOT NULL DEFAULT '{}',
  enabled      BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, agent_id, position)
);
CREATE INDEX IF NOT EXISTS idx_output_proc_agent ON output_processor_chains (agent_id, workspace_id, position);
