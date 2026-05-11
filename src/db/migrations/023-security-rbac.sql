-- ── 023-security-rbac.sql ────────────────────────────────────────────
-- Centralized security tables: audit trail, secret tracking,
-- workspace secrets, and RBAC role assignments.

-- audit_log: ensure required columns exist (007 created with different schema)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'audit_log') THEN
    -- Add columns that 007's schema may be missing
    ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS event TEXT;
    ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS uid TEXT;
    ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS source_ip TEXT;
    ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
    ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
  ELSE
    CREATE TABLE audit_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event TEXT NOT NULL,
      uid TEXT NOT NULL,
      session_id TEXT,
      source_ip TEXT,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'audit_log' AND column_name = 'uid') THEN
    CREATE INDEX IF NOT EXISTS idx_audit_log_uid ON audit_log (uid, created_at DESC);
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'audit_log' AND column_name = 'event') THEN
    CREATE INDEX IF NOT EXISTS idx_audit_log_event ON audit_log (event, created_at DESC);
  END IF;
END $$;

-- secret_audit_log: tracks which secrets were accessed
CREATE TABLE IF NOT EXISTS secret_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  secret_name TEXT NOT NULL,
  backend TEXT NOT NULL DEFAULT 'env',
  process_id TEXT,
  accessed_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_secret_audit_name ON secret_audit_log (secret_name, accessed_at DESC);

-- workspace_secrets: per-workspace API key overrides
CREATE TABLE IF NOT EXISTS workspace_secrets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  secret_key TEXT NOT NULL,
  secret_value TEXT NOT NULL,
  set_by TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  UNIQUE (workspace_id, secret_key)
);
CREATE INDEX IF NOT EXISTS idx_workspace_secrets_ws ON workspace_secrets (workspace_id);

-- rbac_members: fine-grained RBAC role assignments for the security layer.
CREATE TABLE IF NOT EXISTS rbac_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner','editor','tool_runner','viewer')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (workspace_id, uid)
);
CREATE INDEX IF NOT EXISTS idx_rbac_members_uid ON rbac_members (uid, workspace_id);
