import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { getEventBus } from "../events/index.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("tenant-governance");

// ── Tenant Governance Layer ───────────────────────────────────────────
// Multi-tenant isolation and compliance enforcement:
//   - Workspace isolation (logical and resource boundaries)
//   - Role-Based Access Control (RBAC) with custom roles
//   - Usage quotas and rate limiting per tenant
//   - Compliance policies (data residency, retention, access logging)
//   - Tenant lifecycle management

// ── Types ────────────────────────────────────────────────────────────

export type TenantStatus = "active" | "suspended" | "trial" | "churned";
export type TenantPlan = "starter" | "growth" | "enterprise" | "custom";

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  plan: TenantPlan;
  status: TenantStatus;
  ownerId: string;
  settings: TenantSettings;
  quotas: TenantQuotas;
  compliance: ComplianceSettings;
  createdAt: string;
  updatedAt: string;
}

export interface TenantSettings {
  displayName: string;
  domain?: string;
  logoUrl?: string;
  primaryColor?: string;
  ssoEnabled: boolean;
  ssoProvider?: string;
  mfaRequired: boolean;
  ipAllowlist: string[];
  webhookUrl?: string;
  timezone: string;
}

export interface TenantQuotas {
  maxWorkspaces: number;
  maxUsers: number;
  maxAgents: number;
  maxSkills: number;
  maxStorageGb: number;
  maxApiCallsPerDay: number;
  maxConcurrentWorkflows: number;
  maxTokensPerMonth: number;
}

export interface ComplianceSettings {
  dataResidency: string[];
  retentionDays: number;
  auditLogRetentionDays: number;
  requireApprovalForExternalCalls: boolean;
  allowedProviders: string[];
  blockedModels: string[];
  encryptionRequired: boolean;
  dlpEnabled: boolean;
}

export type Permission =
  | "workspace:create" | "workspace:read" | "workspace:update" | "workspace:delete"
  | "agent:create" | "agent:read" | "agent:update" | "agent:delete" | "agent:execute"
  | "skill:install" | "skill:remove" | "skill:execute"
  | "workflow:create" | "workflow:read" | "workflow:execute" | "workflow:cancel"
  | "approval:review" | "approval:override"
  | "billing:read" | "billing:manage"
  | "audit:read" | "audit:export"
  | "settings:read" | "settings:manage"
  | "user:invite" | "user:remove" | "user:manage_roles"
  | "data:read" | "data:write" | "data:delete" | "data:export";

export interface Role {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  permissions: Permission[];
  isSystem: boolean;
  createdAt: string;
}

export interface UserRole {
  userId: string;
  tenantId: string;
  roleId: string;
  workspaceId?: string;
  grantedBy: string;
  grantedAt: string;
}

export interface QuotaUsage {
  tenantId: string;
  workspaces: number;
  users: number;
  agents: number;
  skills: number;
  storageGb: number;
  apiCallsToday: number;
  concurrentWorkflows: number;
  tokensThisMonth: number;
}

// ── Default Roles ───────────────────────────────────────────────────

const SYSTEM_ROLES: Omit<Role, "id" | "tenantId" | "createdAt">[] = [
  {
    name: "owner",
    description: "Full access to all resources and settings",
    permissions: [
      "workspace:create", "workspace:read", "workspace:update", "workspace:delete",
      "agent:create", "agent:read", "agent:update", "agent:delete", "agent:execute",
      "skill:install", "skill:remove", "skill:execute",
      "workflow:create", "workflow:read", "workflow:execute", "workflow:cancel",
      "approval:review", "approval:override",
      "billing:read", "billing:manage",
      "audit:read", "audit:export",
      "settings:read", "settings:manage",
      "user:invite", "user:remove", "user:manage_roles",
      "data:read", "data:write", "data:delete", "data:export",
    ],
    isSystem: true,
  },
  {
    name: "admin",
    description: "Manage resources and users, but cannot change billing",
    permissions: [
      "workspace:create", "workspace:read", "workspace:update",
      "agent:create", "agent:read", "agent:update", "agent:delete", "agent:execute",
      "skill:install", "skill:remove", "skill:execute",
      "workflow:create", "workflow:read", "workflow:execute", "workflow:cancel",
      "approval:review", "approval:override",
      "billing:read",
      "audit:read", "audit:export",
      "settings:read", "settings:manage",
      "user:invite", "user:remove", "user:manage_roles",
      "data:read", "data:write", "data:delete",
    ],
    isSystem: true,
  },
  {
    name: "operator",
    description: "Execute agents and workflows, review approvals",
    permissions: [
      "workspace:read",
      "agent:read", "agent:execute",
      "skill:execute",
      "workflow:read", "workflow:execute",
      "approval:review",
      "audit:read",
      "settings:read",
      "data:read", "data:write",
    ],
    isSystem: true,
  },
  {
    name: "viewer",
    description: "Read-only access to resources and audit logs",
    permissions: [
      "workspace:read",
      "agent:read",
      "workflow:read",
      "audit:read",
      "settings:read",
      "billing:read",
      "data:read",
    ],
    isSystem: true,
  },
];

// ── Default Quotas by Plan ──────────────────────────────────────────

const PLAN_QUOTAS: Record<TenantPlan, TenantQuotas> = {
  starter: {
    maxWorkspaces: 3,
    maxUsers: 5,
    maxAgents: 10,
    maxSkills: 20,
    maxStorageGb: 10,
    maxApiCallsPerDay: 1000,
    maxConcurrentWorkflows: 5,
    maxTokensPerMonth: 1_000_000,
  },
  growth: {
    maxWorkspaces: 10,
    maxUsers: 25,
    maxAgents: 50,
    maxSkills: 100,
    maxStorageGb: 100,
    maxApiCallsPerDay: 10_000,
    maxConcurrentWorkflows: 25,
    maxTokensPerMonth: 10_000_000,
  },
  enterprise: {
    maxWorkspaces: 100,
    maxUsers: 500,
    maxAgents: 500,
    maxSkills: 1000,
    maxStorageGb: 1000,
    maxApiCallsPerDay: 100_000,
    maxConcurrentWorkflows: 100,
    maxTokensPerMonth: 100_000_000,
  },
  custom: {
    maxWorkspaces: 9999,
    maxUsers: 9999,
    maxAgents: 9999,
    maxSkills: 9999,
    maxStorageGb: 9999,
    maxApiCallsPerDay: 999_999,
    maxConcurrentWorkflows: 999,
    maxTokensPerMonth: 999_999_999,
  },
};

// ── Tenant Governance Manager ─────────────────────────────────────────

export class TenantGovernanceManager {
  // ── Tenant Lifecycle ──────────────────────────────────────────────

  async createTenant(params: {
    name: string;
    slug: string;
    plan: TenantPlan;
    ownerId: string;
    settings?: Partial<TenantSettings>;
    compliance?: Partial<ComplianceSettings>;
  }): Promise<Tenant> {
    const pool = getPool();
    const id = randomUUID();

    const settings: TenantSettings = {
      displayName: params.name,
      ssoEnabled: false,
      mfaRequired: false,
      ipAllowlist: [],
      timezone: "UTC",
      ...params.settings,
    };

    const compliance: ComplianceSettings = {
      dataResidency: ["us"],
      retentionDays: 90,
      auditLogRetentionDays: 365,
      requireApprovalForExternalCalls: false,
      allowedProviders: ["claude", "openai", "gemini"],
      blockedModels: [],
      encryptionRequired: true,
      dlpEnabled: true,
      ...params.compliance,
    };

    const quotas = PLAN_QUOTAS[params.plan];

    const tenant: Tenant = {
      id,
      name: params.name,
      slug: params.slug,
      plan: params.plan,
      status: "active",
      ownerId: params.ownerId,
      settings,
      quotas,
      compliance,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await pool.query(
      `INSERT INTO tenants (id, name, slug, plan, status, owner_id, settings, quotas, compliance)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, params.name, params.slug, params.plan, "active", params.ownerId, JSON.stringify(settings), JSON.stringify(quotas), JSON.stringify(compliance)],
    );

    // Create system roles for this tenant
    await this.initializeRoles(id);

    // Assign owner role
    await this.assignRole(params.ownerId, id, "owner", params.ownerId);

    getEventBus().emit("tenant.created", { tenantId: id, name: params.name, plan: params.plan });
    logger.info(`Created tenant ${params.name} (${id}) on ${params.plan} plan`);
    return tenant;
  }

  async getTenant(tenantId: string): Promise<Tenant | null> {
    const pool = getPool();
    const { rows } = await pool.query(`SELECT * FROM tenants WHERE id = $1`, [tenantId]);
    if (rows.length === 0) return null;
    return this.rowToTenant(rows[0]);
  }

  async suspendTenant(tenantId: string, reason: string): Promise<void> {
    const pool = getPool();
    await pool.query(`UPDATE tenants SET status = 'suspended', updated_at = NOW() WHERE id = $1`, [tenantId]);
    getEventBus().emit("tenant.suspended", { tenantId, reason });
    logger.warn(`Suspended tenant ${tenantId}: ${reason}`);
  }

  async reactivateTenant(tenantId: string): Promise<void> {
    const pool = getPool();
    await pool.query(`UPDATE tenants SET status = 'active', updated_at = NOW() WHERE id = $1`, [tenantId]);
    logger.info(`Reactivated tenant ${tenantId}`);
  }

  // ── RBAC ──────────────────────────────────────────────────────────

  async assignRole(userId: string, tenantId: string, roleName: string, grantedBy: string, workspaceId?: string): Promise<void> {
    const pool = getPool();
    const role = await this.getRoleByName(tenantId, roleName);
    if (!role) throw new Error(`Role not found: ${roleName}`);

    await pool.query(
      `INSERT INTO user_roles (user_id, tenant_id, role_id, workspace_id, granted_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, tenant_id, role_id, COALESCE(workspace_id, '')) DO NOTHING`,
      [userId, tenantId, role.id, workspaceId ?? null, grantedBy],
    );
  }

  async revokeRole(userId: string, tenantId: string, roleName: string): Promise<void> {
    const pool = getPool();
    const role = await this.getRoleByName(tenantId, roleName);
    if (!role) return;
    await pool.query(
      `DELETE FROM user_roles WHERE user_id = $1 AND tenant_id = $2 AND role_id = $3`,
      [userId, tenantId, role.id],
    );
  }

  async checkPermission(userId: string, tenantId: string, permission: Permission, workspaceId?: string): Promise<boolean> {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT r.permissions FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = $1 AND ur.tenant_id = $2
       AND (ur.workspace_id IS NULL OR ur.workspace_id = $3)`,
      [userId, tenantId, workspaceId ?? null],
    );

    for (const row of rows as Array<{ permissions: string | Permission[] }>) {
      const perms = typeof row.permissions === "string" ? JSON.parse(row.permissions) as Permission[] : row.permissions;
      if (perms.includes(permission)) return true;
    }
    return false;
  }

  async getUserPermissions(userId: string, tenantId: string): Promise<Permission[]> {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT r.permissions FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = $1 AND ur.tenant_id = $2`,
      [userId, tenantId],
    );

    const allPerms = new Set<Permission>();
    for (const row of rows as Array<{ permissions: string | Permission[] }>) {
      const perms = typeof row.permissions === "string" ? JSON.parse(row.permissions) as Permission[] : row.permissions;
      for (const p of perms) allPerms.add(p);
    }
    return [...allPerms];
  }

  async createCustomRole(tenantId: string, params: { name: string; description: string; permissions: Permission[] }): Promise<Role> {
    const pool = getPool();
    const id = randomUUID();
    const role: Role = { id, tenantId, name: params.name, description: params.description, permissions: params.permissions, isSystem: false, createdAt: new Date().toISOString() };

    await pool.query(
      `INSERT INTO roles (id, tenant_id, name, description, permissions, is_system)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, tenantId, params.name, params.description, JSON.stringify(params.permissions), false],
    );
    return role;
  }

  // ── Quota Enforcement ─────────────────────────────────────────────

  async checkQuota(tenantId: string, resource: keyof TenantQuotas): Promise<{ allowed: boolean; current: number; limit: number }> {
    const tenant = await this.getTenant(tenantId);
    if (!tenant) return { allowed: false, current: 0, limit: 0 };

    const usage = await this.getUsage(tenantId);
    const limit = tenant.quotas[resource];
    const current = this.getUsageForResource(usage, resource);

    return { allowed: current < limit, current, limit };
  }

  async enforceQuota(tenantId: string, resource: keyof TenantQuotas): Promise<void> {
    const { allowed, current, limit } = await this.checkQuota(tenantId, resource);
    if (!allowed) {
      throw new Error(`Quota exceeded for ${resource}: ${current}/${limit}`);
    }
  }

  async getUsage(tenantId: string): Promise<QuotaUsage> {
    const pool = getPool();

    const [workspaces, users, agents] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int as count FROM workspaces WHERE tenant_id = $1`, [tenantId]),
      pool.query(`SELECT COUNT(*)::int as count FROM user_roles WHERE tenant_id = $1 AND role_id IS NOT NULL`, [tenantId]),
      pool.query(`SELECT COUNT(*)::int as count FROM agent_configs WHERE workspace_id IN (SELECT id FROM workspaces WHERE tenant_id = $1)`, [tenantId]),
    ]);

    return {
      tenantId,
      workspaces: (workspaces.rows[0]?.count as number) ?? 0,
      users: (users.rows[0]?.count as number) ?? 0,
      agents: (agents.rows[0]?.count as number) ?? 0,
      skills: 0,
      storageGb: 0,
      apiCallsToday: 0,
      concurrentWorkflows: 0,
      tokensThisMonth: 0,
    };
  }

  // ── Compliance ────────────────────────────────────────────────────

  async updateCompliance(tenantId: string, updates: Partial<ComplianceSettings>): Promise<void> {
    const pool = getPool();
    const tenant = await this.getTenant(tenantId);
    if (!tenant) throw new Error(`Tenant not found: ${tenantId}`);

    const newCompliance = { ...tenant.compliance, ...updates };
    await pool.query(
      `UPDATE tenants SET compliance = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(newCompliance), tenantId],
    );
  }

  async getComplianceReport(tenantId: string): Promise<{
    tenant: string;
    plan: string;
    compliance: ComplianceSettings;
    violations: Array<{ rule: string; severity: string; detail: string }>;
    score: number;
  }> {
    const tenant = await this.getTenant(tenantId);
    if (!tenant) throw new Error(`Tenant not found: ${tenantId}`);

    const violations: Array<{ rule: string; severity: string; detail: string }> = [];

    if (!tenant.compliance.encryptionRequired) {
      violations.push({ rule: "encryption", severity: "high", detail: "Encryption at rest not enforced" });
    }
    if (!tenant.compliance.dlpEnabled) {
      violations.push({ rule: "dlp", severity: "high", detail: "Data Loss Prevention not enabled" });
    }
    if (!tenant.settings.mfaRequired) {
      violations.push({ rule: "mfa", severity: "medium", detail: "Multi-factor authentication not required" });
    }
    if (tenant.compliance.retentionDays < 30) {
      violations.push({ rule: "retention", severity: "medium", detail: "Data retention below minimum 30 days" });
    }
    if (tenant.settings.ipAllowlist.length === 0) {
      violations.push({ rule: "network", severity: "low", detail: "No IP allowlist configured" });
    }

    const maxScore = 100;
    const penalty = violations.reduce((s, v) => s + (v.severity === "high" ? 20 : v.severity === "medium" ? 10 : 5), 0);
    const score = Math.max(0, maxScore - penalty);

    return {
      tenant: tenant.name,
      plan: tenant.plan,
      compliance: tenant.compliance,
      violations,
      score,
    };
  }

  // ── Internal ──────────────────────────────────────────────────────

  private async initializeRoles(tenantId: string): Promise<void> {
    const pool = getPool();
    for (const roleDef of SYSTEM_ROLES) {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO roles (id, tenant_id, name, description, permissions, is_system)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, name) DO NOTHING`,
        [id, tenantId, roleDef.name, roleDef.description, JSON.stringify(roleDef.permissions), true],
      );
    }
  }

  private async getRoleByName(tenantId: string, name: string): Promise<Role | null> {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT * FROM roles WHERE tenant_id = $1 AND name = $2`,
      [tenantId, name],
    );
    if (rows.length === 0) return null;
    const row = rows[0] as Record<string, unknown>;
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      name: row.name as string,
      description: row.description as string,
      permissions: typeof row.permissions === "string" ? JSON.parse(row.permissions) : row.permissions as Permission[],
      isSystem: row.is_system as boolean,
      createdAt: String(row.created_at),
    };
  }

  private getUsageForResource(usage: QuotaUsage, resource: keyof TenantQuotas): number {
    const mapping: Record<keyof TenantQuotas, keyof QuotaUsage> = {
      maxWorkspaces: "workspaces",
      maxUsers: "users",
      maxAgents: "agents",
      maxSkills: "skills",
      maxStorageGb: "storageGb",
      maxApiCallsPerDay: "apiCallsToday",
      maxConcurrentWorkflows: "concurrentWorkflows",
      maxTokensPerMonth: "tokensThisMonth",
    };
    return usage[mapping[resource]] as number;
  }

  private rowToTenant(row: Record<string, unknown>): Tenant {
    return {
      id: row.id as string,
      name: row.name as string,
      slug: row.slug as string,
      plan: row.plan as TenantPlan,
      status: row.status as TenantStatus,
      ownerId: row.owner_id as string,
      settings: typeof row.settings === "string" ? JSON.parse(row.settings) : row.settings as TenantSettings,
      quotas: typeof row.quotas === "string" ? JSON.parse(row.quotas) : row.quotas as TenantQuotas,
      compliance: typeof row.compliance === "string" ? JSON.parse(row.compliance) : row.compliance as ComplianceSettings,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}

// ── Singleton ───────────────────────────────────────────────────────

let instance: TenantGovernanceManager | null = null;

export function getTenantGovernanceManager(): TenantGovernanceManager {
  if (!instance) instance = new TenantGovernanceManager();
  return instance;
}
