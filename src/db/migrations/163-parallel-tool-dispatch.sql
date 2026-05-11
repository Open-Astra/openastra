CREATE TABLE IF NOT EXISTS parallel_tool_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  swarm_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','dispatching','running','completed','partial_failure')) DEFAULT 'pending',
  total_calls INT NOT NULL DEFAULT 0,
  completed_calls INT NOT NULL DEFAULT 0,
  failed_calls INT NOT NULL DEFAULT 0,
  max_parallelism INT NOT NULL DEFAULT 5,
  timeout_ms INT NOT NULL DEFAULT 30000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS parallel_tool_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES parallel_tool_batches(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_params JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed','timeout')) DEFAULT 'pending',
  result JSONB,
  error TEXT,
  duration_ms INT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_parallel_tool_items_batch ON parallel_tool_items(batch_id);
CREATE INDEX IF NOT EXISTS idx_parallel_tool_batches_ws ON parallel_tool_batches(workspace_id);