CREATE TABLE IF NOT EXISTS work_queues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  team_id TEXT,
  max_depth INT DEFAULT 100,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(workspace_id, name)
);

CREATE TABLE IF NOT EXISTS work_queue_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_id UUID REFERENCES work_queues(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  payload JSONB,
  priority INT DEFAULT 3,
  deadline TIMESTAMPTZ,
  assigned_to TEXT,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','assigned','completed','failed')),
  result JSONB,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_wq_ws ON work_queues (workspace_id);
CREATE INDEX IF NOT EXISTS idx_wqt_dequeue ON work_queue_tasks (queue_id, status, priority, deadline);
