-- JWT revocation list and login attempt tracking
-- Supports access token revocation (jti-based), brute-force tracking, and token replay detection.

-- Revoked access tokens checked on every authenticated request
CREATE TABLE IF NOT EXISTS revoked_tokens (
  jti TEXT PRIMARY KEY,
  uid TEXT,
  exp TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_revoked_tokens_exp ON revoked_tokens (exp);
CREATE INDEX IF NOT EXISTS idx_revoked_tokens_uid ON revoked_tokens (uid) WHERE uid IS NOT NULL;

-- Login attempt tracking for brute-force protection
CREATE TABLE IF NOT EXISTS login_attempts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ip TEXT NOT NULL,
  attempted_at TIMESTAMPTZ DEFAULT NOW(),
  success BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time ON login_attempts (ip, attempted_at);

-- Add token_family column to refresh_tokens for replay detection
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS token_family TEXT;
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens (token_family) WHERE token_family IS NOT NULL;
