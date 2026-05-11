-- 038: Memory retention policies for per-workspace TTL and GDPR compliance
-- Phase 4.4 of security audit

CREATE TABLE IF NOT EXISTS memory_retention_policies (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  ttl_days     INTEGER NOT NULL DEFAULT 90,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for the scheduled purge job to scan efficiently
CREATE INDEX IF NOT EXISTS idx_memory_retention_policies_ttl
  ON memory_retention_policies (ttl_days);
