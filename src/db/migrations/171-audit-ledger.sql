-- Tamper-Proof Audit Ledger: append-only Merkle hash chain for all
-- agent decisions and tool calls. Cryptographically verifiable for
-- SOC2/HIPAA/FedRAMP compliance audits.

CREATE TABLE IF NOT EXISTS audit_ledger (
  sequence_num  BIGSERIAL PRIMARY KEY,  -- monotonic, gap-free
  workspace_id  TEXT NOT NULL,
  -- Entry content
  entry_type    TEXT NOT NULL,          -- agent.decision | tool.call | tool.result | memory.write | config.change
  agent_id      TEXT,
  session_id    TEXT,
  uid           TEXT,
  payload       JSONB NOT NULL,         -- the actual event data
  -- Hash chain
  entry_hash    TEXT NOT NULL,          -- SHA-256(sequence_num || prev_hash || payload)
  prev_hash     TEXT NOT NULL,          -- hash of the previous entry (genesis = '0')
  -- Merkle tree
  merkle_root   TEXT,                   -- periodic Merkle root checkpoint (every 1000 entries)
  -- Metadata
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_ledger_workspace ON audit_ledger(workspace_id);
CREATE INDEX IF NOT EXISTS idx_audit_ledger_type ON audit_ledger(entry_type);
CREATE INDEX IF NOT EXISTS idx_audit_ledger_agent ON audit_ledger(agent_id);
CREATE INDEX IF NOT EXISTS idx_audit_ledger_session ON audit_ledger(session_id);
CREATE INDEX IF NOT EXISTS idx_audit_ledger_created ON audit_ledger(created_at);

-- Merkle checkpoints for fast integrity verification
CREATE TABLE IF NOT EXISTS audit_ledger_checkpoints (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  TEXT NOT NULL,
  from_seq      BIGINT NOT NULL,
  to_seq        BIGINT NOT NULL,
  merkle_root   TEXT NOT NULL,
  entry_count   INT NOT NULL,
  verified_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ledger_checkpoints_workspace ON audit_ledger_checkpoints(workspace_id);
