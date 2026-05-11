-- Migration 091: Per-workspace rate limit tiers
-- Override global RPM/burst limits on a per-workspace basis.

CREATE TABLE IF NOT EXISTS workspace_rate_limits (
  workspace_id UUID PRIMARY KEY,
  rpm          INT NOT NULL DEFAULT 60,
  burst        INT NOT NULL DEFAULT 20,
  updated_at   TIMESTAMPTZ DEFAULT now()
);
