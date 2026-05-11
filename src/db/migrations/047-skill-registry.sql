CREATE TABLE IF NOT EXISTS workspace_skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '1.0.0',
  manifest JSONB NOT NULL DEFAULT '{}',
  source_url TEXT,
  published_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workspace_id, name)
);
CREATE TABLE IF NOT EXISTS skill_subscriptions (
  workspace_id UUID NOT NULL,
  skill_id UUID NOT NULL REFERENCES workspace_skills(id) ON DELETE CASCADE,
  pinned_version TEXT,
  subscribed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, skill_id)
);
CREATE INDEX IF NOT EXISTS idx_workspace_skills_workspace ON workspace_skills(workspace_id);
