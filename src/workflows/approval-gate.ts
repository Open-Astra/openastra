import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { getEventBus } from "../events/index.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("approval-gate");

// ── Approval Gate System ──────────────────────────────────────────────
// Every agent action that modifies external state produces a structured
// Proposal object. Proposals are routed through approval policies before
// execution. Supports:
//   - Automatic approval for low-risk actions within policy
//   - Human-in-the-loop review for high-risk actions
//   - Escalation chains (reviewer → manager → admin)
//   - Time-bounded auto-approve with configurable thresholds
//   - Bulk approval/rejection for batch operations

// ── Types ────────────────────────────────────────────────────────────

export type ProposalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "auto_approved"
  | "escalated";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type ActionCategory =
  | "data_read"
  | "data_write"
  | "data_delete"
  | "config_change"
  | "external_api"
  | "billing_action"
  | "user_facing"
  | "infrastructure"
  | "security_sensitive";

export interface Proposal {
  id: string;
  runId?: string;
  workspaceId: string;
  tenantId: string;
  agentId: string;
  uid: string;
  action: string;
  category: ActionCategory;
  riskLevel: RiskLevel;
  description: string;
  params: Record<string, unknown>;
  expectedOutcome: string;
  reversible: boolean;
  status: ProposalStatus;
  reviewedBy?: string;
  reviewNote?: string;
  policyId?: string;
  expiresAt: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface ApprovalPolicy {
  id: string;
  tenantId: string;
  name: string;
  rules: ApprovalRule[];
  escalationChain: EscalationStep[];
  enabled: boolean;
  createdAt: string;
}

export interface ApprovalRule {
  category: ActionCategory | "*";
  maxRiskLevel: RiskLevel;
  autoApprove: boolean;
  requireCount: number;
  timeoutMinutes: number;
  conditions?: RuleCondition[];
}

export interface RuleCondition {
  field: string;
  operator: "eq" | "neq" | "gt" | "lt" | "contains" | "matches";
  value: string | number;
}

export interface EscalationStep {
  level: number;
  role: string;
  timeoutMinutes: number;
  notifyChannel?: string;
}

export interface ApprovalDecision {
  proposalId: string;
  decision: "approved" | "rejected";
  reviewerId: string;
  note?: string;
}

// ── Risk Scoring ────────────────────────────────────────────────────

const RISK_SCORES: Record<RiskLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const CATEGORY_BASE_RISK: Record<ActionCategory, RiskLevel> = {
  data_read: "low",
  data_write: "medium",
  data_delete: "high",
  config_change: "high",
  external_api: "medium",
  billing_action: "high",
  user_facing: "medium",
  infrastructure: "critical",
  security_sensitive: "critical",
};

export function assessRisk(category: ActionCategory, params: Record<string, unknown>): RiskLevel {
  const baseRisk = CATEGORY_BASE_RISK[category];
  let score = RISK_SCORES[baseRisk];

  // Elevate risk based on scope indicators
  if (params.scope === "all" || params.scope === "global") score++;
  if (params.amount && typeof params.amount === "number" && params.amount > 1000) score++;
  if (params.irreversible === true) score++;
  if (params.affectedUsers && typeof params.affectedUsers === "number" && params.affectedUsers > 100) score++;

  if (score >= 4) return "critical";
  if (score >= 3) return "high";
  if (score >= 2) return "medium";
  return "low";
}

// ── Approval Gate Manager ─────────────────────────────────────────────

export class ApprovalGateManager {
  async createProposal(params: {
    runId?: string;
    workspaceId: string;
    tenantId: string;
    agentId: string;
    uid: string;
    action: string;
    category: ActionCategory;
    description: string;
    actionParams: Record<string, unknown>;
    expectedOutcome: string;
    reversible?: boolean;
  }): Promise<Proposal> {
    const pool = getPool();
    const id = randomUUID();
    const riskLevel = assessRisk(params.category, params.actionParams);

    // Check policy for auto-approval
    const policy = await this.getActivePolicy(params.tenantId);
    const autoApproved = policy ? this.evaluateAutoApproval(policy, params.category, riskLevel) : false;

    const defaultTimeout = policy?.rules.find(
      (r) => r.category === params.category || r.category === "*",
    )?.timeoutMinutes ?? 60;

    const expiresAt = new Date(Date.now() + defaultTimeout * 60_000).toISOString();

    const proposal: Proposal = {
      id,
      runId: params.runId,
      workspaceId: params.workspaceId,
      tenantId: params.tenantId,
      agentId: params.agentId,
      uid: params.uid,
      action: params.action,
      category: params.category,
      riskLevel,
      description: params.description,
      params: params.actionParams,
      expectedOutcome: params.expectedOutcome,
      reversible: params.reversible ?? true,
      status: autoApproved ? "auto_approved" : "pending",
      policyId: policy?.id,
      expiresAt,
      createdAt: new Date().toISOString(),
      resolvedAt: autoApproved ? new Date().toISOString() : undefined,
    };

    await pool.query(
      `INSERT INTO approval_proposals (id, run_id, workspace_id, tenant_id, agent_id, uid, action, category, risk_level, description, params, expected_outcome, reversible, status, policy_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [id, params.runId, params.workspaceId, params.tenantId, params.agentId, params.uid, params.action, params.category, riskLevel, params.description, JSON.stringify(params.actionParams), params.expectedOutcome, params.reversible ?? true, proposal.status, policy?.id, expiresAt],
    );

    const bus = getEventBus();
    if (autoApproved) {
      bus.emit("approval.auto_approved", { proposalId: id, action: params.action, riskLevel });
      logger.info(`Auto-approved proposal ${id}: ${params.action} (risk: ${riskLevel})`);
    } else {
      bus.emit("approval.pending", { proposalId: id, action: params.action, riskLevel, tenantId: params.tenantId });
      logger.info(`Proposal ${id} pending approval: ${params.action} (risk: ${riskLevel})`);
    }

    return proposal;
  }

  async decide(decision: ApprovalDecision): Promise<Proposal> {
    const pool = getPool();
    const proposal = await this.getProposal(decision.proposalId);
    if (!proposal) throw new Error(`Proposal not found: ${decision.proposalId}`);
    if (proposal.status !== "pending" && proposal.status !== "escalated") {
      throw new Error(`Proposal ${decision.proposalId} is not pending (status: ${proposal.status})`);
    }

    const newStatus: ProposalStatus = decision.decision === "approved" ? "approved" : "rejected";

    await pool.query(
      `UPDATE approval_proposals SET status = $1, reviewed_by = $2, review_note = $3, resolved_at = NOW() WHERE id = $4`,
      [newStatus, decision.reviewerId, decision.note, decision.proposalId],
    );

    const bus = getEventBus();
    bus.emit(`approval.${newStatus}`, {
      proposalId: decision.proposalId,
      reviewerId: decision.reviewerId,
      action: proposal.action,
    });

    logger.info(`Proposal ${decision.proposalId} ${newStatus} by ${decision.reviewerId}`);

    // If this proposal is part of a durable run, resume it
    if (proposal.runId && newStatus === "approved") {
      bus.emit("workflow.approval_granted", { runId: proposal.runId, proposalId: decision.proposalId });
    }

    return { ...proposal, status: newStatus, reviewedBy: decision.reviewerId, reviewNote: decision.note };
  }

  async bulkDecide(decisions: ApprovalDecision[]): Promise<Proposal[]> {
    const results: Proposal[] = [];
    for (const decision of decisions) {
      results.push(await this.decide(decision));
    }
    return results;
  }

  async escalate(proposalId: string): Promise<void> {
    const pool = getPool();
    const proposal = await this.getProposal(proposalId);
    if (!proposal) throw new Error(`Proposal not found: ${proposalId}`);

    const policy = proposal.policyId ? await this.getPolicy(proposal.policyId) : null;
    if (!policy || policy.escalationChain.length === 0) {
      logger.warn(`No escalation chain for proposal ${proposalId}`);
      return;
    }

    await pool.query(
      `UPDATE approval_proposals SET status = 'escalated', updated_at = NOW() WHERE id = $1`,
      [proposalId],
    );

    getEventBus().emit("approval.escalated", {
      proposalId,
      action: proposal.action,
      tenantId: proposal.tenantId,
    });
    logger.info(`Proposal ${proposalId} escalated`);
  }

  async expireStaleProposals(): Promise<number> {
    const pool = getPool();
    const { rowCount } = await pool.query(
      `UPDATE approval_proposals SET status = 'expired', resolved_at = NOW()
       WHERE status IN ('pending', 'escalated') AND expires_at < NOW()`,
    );
    if (rowCount && rowCount > 0) {
      logger.info(`Expired ${rowCount} stale proposals`);
    }
    return rowCount ?? 0;
  }

  // ── Queries ───────────────────────────────────────────────────────

  async getProposal(id: string): Promise<Proposal | null> {
    const pool = getPool();
    const { rows } = await pool.query(`SELECT * FROM approval_proposals WHERE id = $1`, [id]);
    if (rows.length === 0) return null;
    return this.rowToProposal(rows[0]);
  }

  async listPendingProposals(tenantId: string, limit = 50): Promise<Proposal[]> {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT * FROM approval_proposals WHERE tenant_id = $1 AND status IN ('pending', 'escalated') ORDER BY created_at DESC LIMIT $2`,
      [tenantId, limit],
    );
    return rows.map((r: Record<string, unknown>) => this.rowToProposal(r));
  }

  async listProposals(tenantId: string, filters?: { status?: ProposalStatus; agentId?: string; limit?: number }): Promise<Proposal[]> {
    const pool = getPool();
    let query = `SELECT * FROM approval_proposals WHERE tenant_id = $1`;
    const params: unknown[] = [tenantId];

    if (filters?.status) {
      params.push(filters.status);
      query += ` AND status = $${params.length}`;
    }
    if (filters?.agentId) {
      params.push(filters.agentId);
      query += ` AND agent_id = $${params.length}`;
    }
    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(filters?.limit ?? 100);

    const { rows } = await pool.query(query, params);
    return rows.map((r: Record<string, unknown>) => this.rowToProposal(r));
  }

  // ── Policy Management ─────────────────────────────────────────────

  async createPolicy(params: {
    tenantId: string;
    name: string;
    rules: ApprovalRule[];
    escalationChain: EscalationStep[];
  }): Promise<ApprovalPolicy> {
    const pool = getPool();
    const id = randomUUID();
    const policy: ApprovalPolicy = {
      id,
      tenantId: params.tenantId,
      name: params.name,
      rules: params.rules,
      escalationChain: params.escalationChain,
      enabled: true,
      createdAt: new Date().toISOString(),
    };

    await pool.query(
      `INSERT INTO approval_policies (id, tenant_id, name, rules, escalation_chain, enabled)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, params.tenantId, params.name, JSON.stringify(params.rules), JSON.stringify(params.escalationChain), true],
    );

    return policy;
  }

  async getActivePolicy(tenantId: string): Promise<ApprovalPolicy | null> {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT * FROM approval_policies WHERE tenant_id = $1 AND enabled = true ORDER BY created_at DESC LIMIT 1`,
      [tenantId],
    );
    if (rows.length === 0) return null;
    return this.rowToPolicy(rows[0]);
  }

  async getPolicy(id: string): Promise<ApprovalPolicy | null> {
    const pool = getPool();
    const { rows } = await pool.query(`SELECT * FROM approval_policies WHERE id = $1`, [id]);
    if (rows.length === 0) return null;
    return this.rowToPolicy(rows[0]);
  }

  // ── Internal ──────────────────────────────────────────────────────

  private evaluateAutoApproval(policy: ApprovalPolicy, category: ActionCategory, riskLevel: RiskLevel): boolean {
    for (const rule of policy.rules) {
      if (rule.category !== "*" && rule.category !== category) continue;
      if (!rule.autoApprove) continue;
      if (RISK_SCORES[riskLevel] <= RISK_SCORES[rule.maxRiskLevel]) {
        return true;
      }
    }
    return false;
  }

  private rowToProposal(row: Record<string, unknown>): Proposal {
    return {
      id: row.id as string,
      runId: row.run_id as string | undefined,
      workspaceId: row.workspace_id as string,
      tenantId: row.tenant_id as string,
      agentId: row.agent_id as string,
      uid: row.uid as string,
      action: row.action as string,
      category: row.category as ActionCategory,
      riskLevel: row.risk_level as RiskLevel,
      description: row.description as string,
      params: typeof row.params === "string" ? JSON.parse(row.params) : row.params as Record<string, unknown>,
      expectedOutcome: row.expected_outcome as string,
      reversible: row.reversible as boolean,
      status: row.status as ProposalStatus,
      reviewedBy: row.reviewed_by as string | undefined,
      reviewNote: row.review_note as string | undefined,
      policyId: row.policy_id as string | undefined,
      expiresAt: String(row.expires_at),
      createdAt: String(row.created_at),
      resolvedAt: row.resolved_at ? String(row.resolved_at) : undefined,
    };
  }

  private rowToPolicy(row: Record<string, unknown>): ApprovalPolicy {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      name: row.name as string,
      rules: typeof row.rules === "string" ? JSON.parse(row.rules) : row.rules as ApprovalRule[],
      escalationChain: typeof row.escalation_chain === "string" ? JSON.parse(row.escalation_chain) : row.escalation_chain as EscalationStep[],
      enabled: row.enabled as boolean,
      createdAt: String(row.created_at),
    };
  }
}

// ── Singleton ───────────────────────────────────────────────────────

let instance: ApprovalGateManager | null = null;

export function getApprovalGateManager(): ApprovalGateManager {
  if (!instance) instance = new ApprovalGateManager();
  return instance;
}
