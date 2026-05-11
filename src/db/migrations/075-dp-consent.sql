CREATE TABLE IF NOT EXISTS dp_budgets (
  workspace_id UUID NOT NULL,
  uid TEXT NOT NULL,
  epsilon_used NUMERIC DEFAULT 0,
  epsilon_limit NUMERIC DEFAULT 10,
  queries_count INT DEFAULT 0,
  last_query_at TIMESTAMPTZ,
  reset_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 days'),
  PRIMARY KEY (workspace_id, uid)
);

CREATE TABLE IF NOT EXISTS user_consents (
  workspace_id UUID NOT NULL,
  uid TEXT NOT NULL,
  consent_type TEXT NOT NULL,
  granted BOOLEAN NOT NULL,
  granted_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, uid, consent_type)
);
