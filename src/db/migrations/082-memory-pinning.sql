-- Migration 082: Memory pinning
-- Marks specific memory entries as permanent (exempt from TTL / pruning).

ALTER TABLE daily_memory ADD COLUMN IF NOT EXISTS pinned    BOOLEAN     NOT NULL DEFAULT false;
ALTER TABLE daily_memory ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_daily_memory_pinned
  ON daily_memory(user_id, workspace_id) WHERE pinned = true;
