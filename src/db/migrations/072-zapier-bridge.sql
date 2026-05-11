-- Migration 072: Zapier Bridge + Jira Sync Configs
-- Zapier REST Hooks bridge subscriptions
CREATE TABLE IF NOT EXISTS zapier_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  hook_url TEXT NOT NULL,
  event_filter TEXT DEFAULT '*',
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_triggered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_zapier_subscriptions_workspace
  ON zapier_subscriptions (workspace_id);

-- Jira bidirectional sync configuration per workspace
CREATE TABLE IF NOT EXISTS jira_sync_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL UNIQUE,
  jira_base_url TEXT NOT NULL,
  api_token TEXT NOT NULL,
  project_key TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  enabled BOOLEAN DEFAULT true,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jira_sync_configs_workspace
  ON jira_sync_configs (workspace_id);
