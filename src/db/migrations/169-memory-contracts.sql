-- Memory Contracts: enforceable SLAs per workspace for memory retention,
-- recall latency, data residency, and archive policies.

CREATE TABLE IF NOT EXISTS memory_contracts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  TEXT NOT NULL,
  name          TEXT NOT NULL,
  -- Retention
  max_retention_days    INT,           -- memories older than this get archived/deleted
  min_retention_days    INT,           -- cannot delete memories younger than this
  -- Performance
  max_recall_ms         INT,           -- SLA: memory search must return within this
  -- Data residency
  data_residency_region TEXT,          -- e.g. 'eu-west-1', 'us-east-1'
  -- Archive policy
  archive_policy        TEXT NOT NULL DEFAULT 'cold_store',  -- cold_store | delete | compress
  -- Tier restrictions
  tier_restrictions     JSONB NOT NULL DEFAULT '{}',  -- per-tier overrides {"daily": {"maxRetentionDays": 30}}
  -- Enforcement
  enforce               BOOLEAN NOT NULL DEFAULT true,
  last_enforced_at      TIMESTAMPTZ,
  violations_count      INT NOT NULL DEFAULT 0,
  -- Metadata
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workspace_id, name)
);

CREATE INDEX IF NOT EXISTS idx_memory_contracts_workspace ON memory_contracts(workspace_id);

-- Violation log for audit trail
CREATE TABLE IF NOT EXISTS memory_contract_violations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id   UUID NOT NULL REFERENCES memory_contracts(id) ON DELETE CASCADE,
  workspace_id  TEXT NOT NULL,
  violation_type TEXT NOT NULL,  -- retention_exceeded | recall_sla_breach | residency_violation
  details       JSONB NOT NULL DEFAULT '{}',
  resolved      BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contract_violations_contract ON memory_contract_violations(contract_id);
CREATE INDEX IF NOT EXISTS idx_contract_violations_workspace ON memory_contract_violations(workspace_id);
