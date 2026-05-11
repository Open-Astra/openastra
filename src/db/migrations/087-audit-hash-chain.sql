-- Migration 087: Audit hash chain
-- Adds cryptographic chaining to audit_log for tamper evidence.

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS hash      TEXT;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS prev_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_log_hash           ON audit_log(hash);
CREATE INDEX IF NOT EXISTS idx_audit_log_workspace_time ON audit_log(workspace_id, created_at DESC);
