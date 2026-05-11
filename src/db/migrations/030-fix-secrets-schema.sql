-- 030: Reconcile secrets schema
-- Databases that ran the now-deleted 023-secrets.sql before 023-security-rbac.sql
-- ended up with slightly different column schemas. This migration brings them in line
-- with what 023-security-rbac.sql intended. All statements are idempotent.

-- secret_audit_log: 023-secrets.sql created process_id as NOT NULL; make it nullable
-- and add the backend column (with default) if missing.
ALTER TABLE secret_audit_log ALTER COLUMN process_id DROP NOT NULL;
ALTER TABLE secret_audit_log ADD COLUMN IF NOT EXISTS backend TEXT NOT NULL DEFAULT 'env';

-- workspace_secrets: 023-secrets.sql used a composite PK with no id column.
-- Add id and created_at if they don't exist yet.
ALTER TABLE workspace_secrets ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid();
ALTER TABLE workspace_secrets ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
