-- Audit log
CREATE TABLE IF NOT EXISTS audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id    TEXT NOT NULL,
  session_id  UUID REFERENCES sessions(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  details     JSONB NOT NULL DEFAULT '{}',
  timestamp   BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id, timestamp DESC);

-- Role ledger (token budgets per agent role)
CREATE TABLE IF NOT EXISTS role_ledger (
  agent_id    TEXT NOT NULL,
  role        TEXT NOT NULL,
  tokens_used BIGINT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (agent_id, role)
);

-- User role ledger
CREATE TABLE IF NOT EXISTS user_role_ledger (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id    TEXT NOT NULL,
  tokens_used BIGINT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, agent_id)
);

-- Execution log
CREATE TABLE IF NOT EXISTS execution_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      TEXT NOT NULL,
  session_id    UUID REFERENCES sessions(id) ON DELETE SET NULL,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_name     TEXT,
  duration_ms   INTEGER NOT NULL DEFAULT 0,
  token_usage   JSONB NOT NULL DEFAULT '{}',
  error         TEXT,
  timestamp     BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_execution_log_agent ON execution_log(agent_id, timestamp DESC);

-- Swarms
CREATE TABLE IF NOT EXISTS swarms (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  config      JSONB NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Budget nodes (per-agent budget tracking within swarms)
CREATE TABLE IF NOT EXISTS budget_nodes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  swarm_id    UUID REFERENCES swarms(id) ON DELETE CASCADE,
  agent_id    TEXT NOT NULL,
  budget      JSONB NOT NULL DEFAULT '{"allocated":0,"used":0}',
  usage       JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Orchestrators
CREATE TABLE IF NOT EXISTS orchestrators (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  swarm_id    UUID REFERENCES swarms(id) ON DELETE CASCADE,
  agent_id    TEXT NOT NULL,
  strategy    TEXT NOT NULL DEFAULT 'round-robin',
  config      JSONB NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Blackboard entries (shared state between agents)
CREATE TABLE IF NOT EXISTS blackboard_entries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  swarm_id     UUID REFERENCES swarms(id) ON DELETE CASCADE,
  key          TEXT NOT NULL,
  value        JSONB NOT NULL,
  written_by   TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (swarm_id, key)
);

-- Blackboard conflicts
CREATE TABLE IF NOT EXISTS blackboard_conflicts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id        UUID NOT NULL REFERENCES blackboard_entries(id) ON DELETE CASCADE,
  conflicting_value JSONB NOT NULL,
  written_by      TEXT NOT NULL,
  resolved        BOOLEAN NOT NULL DEFAULT false,
  resolved_by     TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Curator contradictions
CREATE TABLE IF NOT EXISTS curator_contradictions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id     TEXT NOT NULL,
  claim_a      TEXT NOT NULL,
  claim_b      TEXT NOT NULL,
  resolution   TEXT,
  resolved     BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_curator_contradictions_user ON curator_contradictions(user_id);
