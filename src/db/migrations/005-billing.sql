-- Billing usage tracking (replaces Firestore users/{uid}/billing/{month})
CREATE TABLE IF NOT EXISTS billing_usage (
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id         UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  month                TEXT NOT NULL,  -- YYYY-MM
  total_prompt_tokens  BIGINT NOT NULL DEFAULT 0,
  total_completion_tokens BIGINT NOT NULL DEFAULT 0,
  total_tokens         BIGINT NOT NULL DEFAULT 0,
  total_cached_tokens  BIGINT NOT NULL DEFAULT 0,
  request_count        INTEGER NOT NULL DEFAULT 0,
  by_agent             JSONB NOT NULL DEFAULT '{}',
  updated_at           TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, month, workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_billing_usage_user_month ON billing_usage(user_id, month);
