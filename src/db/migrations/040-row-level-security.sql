-- Migration 040: Row-Level Security policies for multi-tenant isolation
-- Adds workspace_id to audit_log and enables RLS on sensitive tables.
--
-- RLS is enforced via session variables set per-request:
--   SET LOCAL app.current_uid = '<uid>';
--   SET LOCAL app.current_workspace_id = '<workspace_id>';
--
-- Application code must SET these before querying protected tables.

-- ── 1. Add workspace_id to audit_log ─────────────────────────────────

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS workspace_id TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_log_workspace
  ON audit_log (workspace_id) WHERE workspace_id IS NOT NULL;

-- ── 2. Enable RLS on sessions ────────────────────────────────────────

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

-- Bypass for the application role (service account queries aren't filtered)
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sessions_isolation ON sessions;
CREATE POLICY sessions_isolation ON sessions
  USING (
    -- Personal sessions: user must match
    (workspace_id IS NULL AND user_id = current_setting('app.current_uid', true))
    OR
    -- Workspace sessions: workspace must match
    (workspace_id IS NOT NULL AND workspace_id::text = current_setting('app.current_workspace_id', true))
    OR
    -- Service bypass: when no session vars are set (internal/scheduler queries)
    (current_setting('app.current_uid', true) IS NULL OR current_setting('app.current_uid', true) = '')
  );

-- ── 3. Enable RLS on daily_memory ────────────────────────────────────

ALTER TABLE daily_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_memory FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS daily_memory_isolation ON daily_memory;
CREATE POLICY daily_memory_isolation ON daily_memory
  USING (
    -- Owner access
    (user_id = current_setting('app.current_uid', true))
    OR
    -- Service bypass
    (current_setting('app.current_uid', true) IS NULL OR current_setting('app.current_uid', true) = '')
  );

-- ── 4. Enable RLS on audit_log ───────────────────────────────────────

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

-- Write policy: anyone can INSERT (fire-and-forget logging)
DROP POLICY IF EXISTS audit_log_insert ON audit_log;
CREATE POLICY audit_log_insert ON audit_log
  FOR INSERT
  WITH CHECK (true);

-- Read policy: user sees own logs, or workspace-scoped logs
DROP POLICY IF EXISTS audit_log_read ON audit_log;
CREATE POLICY audit_log_read ON audit_log
  FOR SELECT
  USING (
    (uid = current_setting('app.current_uid', true))
    OR
    (workspace_id IS NOT NULL AND workspace_id = current_setting('app.current_workspace_id', true))
    OR
    (current_setting('app.current_uid', true) IS NULL OR current_setting('app.current_uid', true) = '')
  );

-- ── 5. Enable RLS on memory_profiles (034 schema) ───────────────────

DO $$
BEGIN
  -- Only apply if the 034 memory_profiles table exists with workspace_id
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memory_profiles' AND column_name = 'workspace_id'
  ) THEN
    EXECUTE 'ALTER TABLE memory_profiles ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE memory_profiles FORCE ROW LEVEL SECURITY';

    EXECUTE 'DROP POLICY IF EXISTS memory_profiles_isolation ON memory_profiles';
    EXECUTE $p$
      CREATE POLICY memory_profiles_isolation ON memory_profiles
        USING (
          (workspace_id::text = current_setting('app.current_workspace_id', true))
          OR
          (current_setting('app.current_uid', true) IS NULL OR current_setting('app.current_uid', true) = '')
        )
    $p$;
  END IF;
END $$;

-- ── 6. Helper function to set RLS context ────────────────────────────

CREATE OR REPLACE FUNCTION set_rls_context(p_uid TEXT, p_workspace_id TEXT DEFAULT NULL)
RETURNS VOID AS $$
BEGIN
  PERFORM set_config('app.current_uid', COALESCE(p_uid, ''), true);
  PERFORM set_config('app.current_workspace_id', COALESCE(p_workspace_id, ''), true);
END;
$$ LANGUAGE plpgsql;
