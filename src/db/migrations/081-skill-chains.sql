-- Migration 081: Skill chains
-- Allows composing multiple skills into a named meta-skill.

CREATE TABLE IF NOT EXISTS skill_chains (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  skills       TEXT[] NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_skill_chains_workspace ON skill_chains(workspace_id);
