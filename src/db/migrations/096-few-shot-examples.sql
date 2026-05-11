-- 096: Per-agent few-shot example library
CREATE TABLE IF NOT EXISTS few_shot_examples (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  task_type    TEXT NOT NULL,       -- classifier label, e.g. "summarize", "translate", "code"
  user_message TEXT NOT NULL,
  assistant_response TEXT NOT NULL,
  score        FLOAT DEFAULT 1.0,  -- quality score for ranking
  enabled      BOOLEAN NOT NULL DEFAULT true,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_few_shot_agent_type ON few_shot_examples (agent_id, workspace_id, task_type, score DESC);
