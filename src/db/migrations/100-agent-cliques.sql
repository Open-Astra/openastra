-- 100: Ad-hoc agent clique formation
CREATE TABLE IF NOT EXISTS agent_cliques (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  agent_ids    TEXT[] NOT NULL,
  coordinator_agent_id TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'idle',  -- idle | running | dissolved
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dissolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS clique_runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clique_id    UUID NOT NULL REFERENCES agent_cliques(id) ON DELETE CASCADE,
  task         TEXT NOT NULL,
  result       TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | failed
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cliques_workspace ON agent_cliques (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clique_runs ON clique_runs (clique_id, created_at DESC);
