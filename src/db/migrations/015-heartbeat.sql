CREATE TABLE IF NOT EXISTS heartbeat_configs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  uid              TEXT REFERENCES users(id) ON DELETE SET NULL,
  workspace_id     UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id         TEXT NOT NULL DEFAULT 'default',
  type             TEXT NOT NULL CHECK (type IN ('rss', 'http', 'github')),
  url              TEXT,
  config           JSONB NOT NULL DEFAULT '{}',
  interval_minutes INTEGER NOT NULL DEFAULT 30,
  prompt           TEXT,
  enabled          BOOLEAN NOT NULL DEFAULT true,
  last_run_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_heartbeat_configs_enabled ON heartbeat_configs(enabled, last_run_at);
CREATE INDEX IF NOT EXISTS idx_heartbeat_configs_uid ON heartbeat_configs(uid);
CREATE INDEX IF NOT EXISTS idx_heartbeat_configs_ws ON heartbeat_configs(workspace_id);

CREATE TABLE IF NOT EXISTS heartbeat_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id       UUID NOT NULL REFERENCES heartbeat_configs(id) ON DELETE CASCADE,
  status          TEXT NOT NULL CHECK (status IN ('ok', 'changed', 'error', 'timeout')),
  raw_data        JSONB NOT NULL DEFAULT '{}',
  agent_summary   TEXT,
  duration_ms     INTEGER,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_heartbeat_runs_config ON heartbeat_runs(config_id, created_at DESC);
