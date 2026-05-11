-- Migration: 010-openastra-platform.sql
-- OpenAstra B2B Platform Tables — durable execution, approval gates,
-- audit trail, signed skill registry, outcome billing, egress data plane,
-- tenant governance

-- ── Durable Execution ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS durable_runs (
  id UUID PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  input JSONB NOT NULL DEFAULT '{}',
  config JSONB NOT NULL DEFAULT '{}',
  current_step_index INT NOT NULL DEFAULT 0,
  attempts INT NOT NULL DEFAULT 0,
  last_heartbeat TIMESTAMPTZ DEFAULT NOW(),
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_durable_runs_tenant ON durable_runs(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_durable_runs_heartbeat ON durable_runs(status, last_heartbeat);

CREATE TABLE IF NOT EXISTS workflow_checkpoints (
  id SERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES durable_runs(id) ON DELETE CASCADE,
  step_index INT NOT NULL,
  step_id TEXT NOT NULL,
  vars JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_run ON workflow_checkpoints(run_id, step_index);

CREATE TABLE IF NOT EXISTS dead_letter_queue (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL,
  workflow_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  error TEXT NOT NULL,
  attempts INT NOT NULL,
  input JSONB NOT NULL DEFAULT '{}',
  last_checkpoint JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dlq_tenant ON dead_letter_queue(tenant_id, created_at);

-- ── Approval Gates ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS approval_proposals (
  id UUID PRIMARY KEY,
  run_id UUID,
  workspace_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  action TEXT NOT NULL,
  category TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  description TEXT NOT NULL,
  params JSONB NOT NULL DEFAULT '{}',
  expected_outcome TEXT NOT NULL DEFAULT '',
  reversible BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by TEXT,
  review_note TEXT,
  policy_id UUID,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_proposals_tenant_status ON approval_proposals(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_proposals_expires ON approval_proposals(status, expires_at);

CREATE TABLE IF NOT EXISTS approval_policies (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  rules JSONB NOT NULL DEFAULT '[]',
  escalation_chain JSONB NOT NULL DEFAULT '[]',
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Audit Trail ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_trail (
  id UUID PRIMARY KEY,
  sequence BIGINT NOT NULL,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  agent_id TEXT,
  session_id TEXT,
  action TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  evidence JSONB,
  risk_level TEXT NOT NULL DEFAULT 'info',
  previous_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_tenant_seq ON audit_trail(tenant_id, sequence);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_trail(tenant_id, action, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_risk ON audit_trail(tenant_id, risk_level, created_at);

-- ── Signed Skill Registry ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS skill_packages (
  id UUID PRIMARY KEY,
  skill_id TEXT NOT NULL,
  version TEXT NOT NULL,
  publisher_id TEXT NOT NULL,
  manifest JSONB NOT NULL,
  source_hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  trust_level TEXT NOT NULL DEFAULT 'community',
  status TEXT NOT NULL DEFAULT 'draft',
  dependencies JSONB NOT NULL DEFAULT '[]',
  security_metadata JSONB NOT NULL DEFAULT '{}',
  downloads INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(skill_id, version)
);

CREATE INDEX IF NOT EXISTS idx_skill_packages_search ON skill_packages(status, trust_level);

CREATE TABLE IF NOT EXISTS skill_publishers (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  trust_level TEXT NOT NULL DEFAULT 'community',
  verified BOOLEAN NOT NULL DEFAULT false,
  skill_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS skill_installations (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  version TEXT NOT NULL,
  package_id UUID NOT NULL,
  installed_by TEXT NOT NULL,
  pinned_version BOOLEAN NOT NULL DEFAULT false,
  installed_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, workspace_id, skill_id)
);

CREATE TABLE IF NOT EXISTS tenant_skill_policies (
  tenant_id TEXT PRIMARY KEY,
  allowed_trust_levels JSONB NOT NULL DEFAULT '["official","verified","community"]',
  allowed_publishers JSONB NOT NULL DEFAULT '[]',
  blocked_skills JSONB NOT NULL DEFAULT '[]',
  require_signature BOOLEAN NOT NULL DEFAULT true,
  max_vuln_severity TEXT NOT NULL DEFAULT 'high',
  auto_update_minor BOOLEAN NOT NULL DEFAULT false,
  pinned_versions JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Outcome Billing ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS outcome_events (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  type TEXT NOT NULL,
  description TEXT NOT NULL,
  quantity FLOAT NOT NULL,
  unit TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  agent_id TEXT,
  workflow_run_id UUID,
  measured_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outcome_events_tenant ON outcome_events(tenant_id, type, measured_at);

CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  line_items JSONB NOT NULL DEFAULT '[]',
  subtotal FLOAT NOT NULL DEFAULT 0,
  base_fee FLOAT NOT NULL DEFAULT 0,
  total FLOAT NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'draft',
  issued_at TIMESTAMPTZ,
  due_date TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoices_tenant ON invoices(tenant_id, period_start);

CREATE TABLE IF NOT EXISTS tenant_billing (
  tenant_id TEXT PRIMARY KEY,
  tier_id TEXT NOT NULL DEFAULT 'starter',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Egress Data Plane ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS egress_policies (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  rules JSONB NOT NULL DEFAULT '[]',
  allowed_destinations JSONB NOT NULL DEFAULT '[]',
  dlp_rules JSONB NOT NULL DEFAULT '[]',
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS data_flow_logs (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  destination TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'egress',
  payload_size INT NOT NULL DEFAULT 0,
  classifications JSONB NOT NULL DEFAULT '[]',
  decision TEXT NOT NULL,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_data_flow_tenant ON data_flow_logs(tenant_id, timestamp);

-- ── Tenant Governance ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'starter',
  status TEXT NOT NULL DEFAULT 'active',
  owner_id TEXT NOT NULL,
  settings JSONB NOT NULL DEFAULT '{}',
  quotas JSONB NOT NULL DEFAULT '{}',
  compliance JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS roles (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  permissions JSONB NOT NULL DEFAULT '[]',
  is_system BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, name)
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  workspace_id TEXT,
  granted_by TEXT NOT NULL,
  granted_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, tenant_id, role_id, COALESCE(workspace_id, ''))
);

CREATE INDEX IF NOT EXISTS idx_user_roles_lookup ON user_roles(user_id, tenant_id);
