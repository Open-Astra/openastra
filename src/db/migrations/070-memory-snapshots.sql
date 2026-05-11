-- Migration 070: Memory Snapshots
-- Stores point-in-time snapshots of a user's memory for backup/restore

CREATE TABLE IF NOT EXISTS memory_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  uid TEXT NOT NULL,
  snapshot_type TEXT DEFAULT 'manual',
  memory_data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  label TEXT
);

CREATE INDEX IF NOT EXISTS idx_memory_snapshots_uid
  ON memory_snapshots(workspace_id, uid, created_at DESC);
