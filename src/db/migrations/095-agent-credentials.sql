-- 095: Per-agent encrypted credential vault
CREATE TABLE IF NOT EXISTS agent_credentials (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  key          TEXT NOT NULL,       -- credential name, e.g. "GITHUB_TOKEN"
  ciphertext   TEXT NOT NULL,       -- AES-256-GCM encrypted, base64
  iv           TEXT NOT NULL,       -- GCM IV, base64
  description  TEXT,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, agent_id, key)
);
CREATE INDEX IF NOT EXISTS idx_agent_creds_agent ON agent_credentials (agent_id, workspace_id);
