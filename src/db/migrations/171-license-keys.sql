-- License key system (XenForo-style)
-- Caches remote validation results and tracks developer activations.

CREATE TABLE IF NOT EXISTS license_cache (
  id            SERIAL PRIMARY KEY,
  license_key   TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,
  tier          TEXT NOT NULL DEFAULT 'unlicensed',
  valid         BOOLEAN NOT NULL DEFAULT false,
  customer_name TEXT,
  customer_email TEXT,
  max_developers INTEGER NOT NULL DEFAULT 1,
  max_deployments INTEGER NOT NULL DEFAULT 1,
  licensed_url  TEXT,
  validation_response JSONB,
  validated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (license_key, fingerprint)
);

CREATE TABLE IF NOT EXISTS license_activations (
  id            SERIAL PRIMARY KEY,
  license_key   TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (license_key, user_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_license_activations_key ON license_activations (license_key);
