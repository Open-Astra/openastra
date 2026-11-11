-- 203: Make the audit ledger hash chain verifiable and append-only.
--
-- * chain_seq     — per-workspace position in the chain. sequence_num is a
--                   global BIGSERIAL shared by every workspace, so it cannot be
--                   the number that is hashed into a per-workspace chain.
-- * hash_version  — 1 = legacy hash (sequence guess + non-canonical JSON, not
--                   reproducible); 2 = canonical hash over chain_seq, type,
--                   agent, session, uid and payload.
-- * Triggers reject UPDATE / DELETE / TRUNCATE so the table is append-only for
--   the application role. (A superuser can still drop the trigger — pair this
--   with REVOKE and off-database checkpoint export for a real compliance posture.)

ALTER TABLE audit_ledger ADD COLUMN IF NOT EXISTS chain_seq BIGINT;
ALTER TABLE audit_ledger ADD COLUMN IF NOT EXISTS hash_version SMALLINT NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_ledger_chain_seq
  ON audit_ledger (workspace_id, chain_seq)
  WHERE chain_seq IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_ledger_workspace_seq
  ON audit_ledger (workspace_id, sequence_num DESC);

CREATE OR REPLACE FUNCTION audit_ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_ledger is append-only (% is not permitted)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_ledger_no_update_delete ON audit_ledger;
CREATE TRIGGER audit_ledger_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_ledger
  FOR EACH ROW EXECUTE FUNCTION audit_ledger_append_only();

DROP TRIGGER IF EXISTS audit_ledger_no_truncate ON audit_ledger;
CREATE TRIGGER audit_ledger_no_truncate
  BEFORE TRUNCATE ON audit_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION audit_ledger_append_only();
