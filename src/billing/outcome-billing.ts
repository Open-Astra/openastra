import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { getEventBus } from "../events/index.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("outcome-billing");

// ── Outcome-Based Billing Plane ───────────────────────────────────────
// Instead of per-token pricing, charges based on outcomes:
//   - SEO: per-ranking-improvement, per-issue-fixed, per-page-optimized
//   - Cloud: per-dollar-saved, per-drift-remediated, per-incident-prevented
//   - General: per-task-completed, per-workflow-executed
//
// Components:
//   - Outcome metering (records measurable outcomes)
//   - Pricing tiers (maps outcomes to charges)
//   - Invoice generation
//   - Usage dashboard data

// ── Types ────────────────────────────────────────────────────────────

export type OutcomeType =
  | "ranking_improvement"
  | "seo_issue_fixed"
  | "page_optimized"
  | "cost_saved"
  | "drift_remediated"
  | "incident_prevented"
  | "cert_renewed"
  | "task_completed"
  | "workflow_executed"
  | "approval_processed";

export interface OutcomeEvent {
  id: string;
  tenantId: string;
  workspaceId: string;
  type: OutcomeType;
  description: string;
  quantity: number;
  unit: string;
  metadata: Record<string, unknown>;
  measuredAt: string;
  agentId?: string;
  workflowRunId?: string;
}

export interface PricingTier {
  id: string;
  name: string;
  outcomes: OutcomePricing[];
  baseFeeMonthly: number;
  includedOutcomes: Record<OutcomeType, number>;
  overageRate: Record<OutcomeType, number>;
}

export interface OutcomePricing {
  type: OutcomeType;
  unitPrice: number;
  unit: string;
  minCharge?: number;
  maxCharge?: number;
}

export interface UsagePeriod {
  tenantId: string;
  periodStart: string;
  periodEnd: string;
  outcomes: Record<OutcomeType, { count: number; totalQuantity: number }>;
  totalCharge: number;
  breakdown: ChargeLineItem[];
}

export interface ChargeLineItem {
  type: OutcomeType;
  description: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  included: number;
  overage: number;
  overageCharge: number;
}

export interface Invoice {
  id: string;
  tenantId: string;
  periodStart: string;
  periodEnd: string;
  lineItems: ChargeLineItem[];
  subtotal: number;
  baseFee: number;
  total: number;
  currency: string;
  status: "draft" | "issued" | "paid" | "overdue" | "void";
  issuedAt?: string;
  dueDate?: string;
  paidAt?: string;
}

// ── Default Pricing ─────────────────────────────────────────────────

const DEFAULT_TIERS: PricingTier[] = [
  {
    id: "starter",
    name: "Starter",
    baseFeeMonthly: 99,
    outcomes: [
      { type: "ranking_improvement", unitPrice: 5, unit: "position gained" },
      { type: "seo_issue_fixed", unitPrice: 2, unit: "issue" },
      { type: "page_optimized", unitPrice: 10, unit: "page" },
      { type: "cost_saved", unitPrice: 0.10, unit: "dollar saved" },
      { type: "drift_remediated", unitPrice: 15, unit: "resource" },
      { type: "incident_prevented", unitPrice: 50, unit: "incident" },
      { type: "cert_renewed", unitPrice: 5, unit: "certificate" },
      { type: "task_completed", unitPrice: 1, unit: "task" },
      { type: "workflow_executed", unitPrice: 3, unit: "workflow" },
      { type: "approval_processed", unitPrice: 0.5, unit: "approval" },
    ],
    includedOutcomes: {
      ranking_improvement: 20,
      seo_issue_fixed: 50,
      page_optimized: 10,
      cost_saved: 500,
      drift_remediated: 5,
      incident_prevented: 2,
      cert_renewed: 10,
      task_completed: 100,
      workflow_executed: 30,
      approval_processed: 50,
    },
    overageRate: {
      ranking_improvement: 7,
      seo_issue_fixed: 3,
      page_optimized: 12,
      cost_saved: 0.15,
      drift_remediated: 20,
      incident_prevented: 75,
      cert_renewed: 7,
      task_completed: 1.5,
      workflow_executed: 4,
      approval_processed: 0.75,
    },
  },
  {
    id: "growth",
    name: "Growth",
    baseFeeMonthly: 499,
    outcomes: [
      { type: "ranking_improvement", unitPrice: 3, unit: "position gained" },
      { type: "seo_issue_fixed", unitPrice: 1, unit: "issue" },
      { type: "page_optimized", unitPrice: 7, unit: "page" },
      { type: "cost_saved", unitPrice: 0.07, unit: "dollar saved" },
      { type: "drift_remediated", unitPrice: 10, unit: "resource" },
      { type: "incident_prevented", unitPrice: 35, unit: "incident" },
      { type: "cert_renewed", unitPrice: 3, unit: "certificate" },
      { type: "task_completed", unitPrice: 0.5, unit: "task" },
      { type: "workflow_executed", unitPrice: 2, unit: "workflow" },
      { type: "approval_processed", unitPrice: 0.25, unit: "approval" },
    ],
    includedOutcomes: {
      ranking_improvement: 100,
      seo_issue_fixed: 250,
      page_optimized: 50,
      cost_saved: 5000,
      drift_remediated: 25,
      incident_prevented: 10,
      cert_renewed: 50,
      task_completed: 500,
      workflow_executed: 150,
      approval_processed: 250,
    },
    overageRate: {
      ranking_improvement: 4,
      seo_issue_fixed: 1.5,
      page_optimized: 9,
      cost_saved: 0.10,
      drift_remediated: 12,
      incident_prevented: 45,
      cert_renewed: 4,
      task_completed: 0.75,
      workflow_executed: 2.5,
      approval_processed: 0.35,
    },
  },
];

// ── Outcome Billing Manager ───────────────────────────────────────────

export class OutcomeBillingManager {
  async recordOutcome(params: {
    tenantId: string;
    workspaceId: string;
    type: OutcomeType;
    description: string;
    quantity: number;
    unit: string;
    metadata?: Record<string, unknown>;
    agentId?: string;
    workflowRunId?: string;
  }): Promise<OutcomeEvent> {
    const pool = getPool();
    const id = randomUUID();
    const event: OutcomeEvent = {
      id,
      tenantId: params.tenantId,
      workspaceId: params.workspaceId,
      type: params.type,
      description: params.description,
      quantity: params.quantity,
      unit: params.unit,
      metadata: params.metadata ?? {},
      measuredAt: new Date().toISOString(),
      agentId: params.agentId,
      workflowRunId: params.workflowRunId,
    };

    await pool.query(
      `INSERT INTO outcome_events (id, tenant_id, workspace_id, type, description, quantity, unit, metadata, agent_id, workflow_run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, params.tenantId, params.workspaceId, params.type, params.description, params.quantity, params.unit, JSON.stringify(params.metadata ?? {}), params.agentId, params.workflowRunId],
    );

    getEventBus().emit("billing.outcome_recorded", {
      tenantId: params.tenantId,
      type: params.type,
      quantity: params.quantity,
    });

    return event;
  }

  async getUsagePeriod(tenantId: string, periodStart: string, periodEnd: string): Promise<UsagePeriod> {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT type, COUNT(*)::int as count, COALESCE(SUM(quantity), 0)::float as total_quantity
       FROM outcome_events
       WHERE tenant_id = $1 AND measured_at >= $2 AND measured_at < $3
       GROUP BY type`,
      [tenantId, periodStart, periodEnd],
    );

    const outcomes: Record<OutcomeType, { count: number; totalQuantity: number }> = {} as Record<OutcomeType, { count: number; totalQuantity: number }>;
    for (const row of rows as Array<{ type: OutcomeType; count: number; total_quantity: number }>) {
      outcomes[row.type] = { count: row.count, totalQuantity: row.total_quantity };
    }

    // Get tenant's pricing tier
    const tier = await this.getTenantTier(tenantId);
    const breakdown = this.calculateCharges(outcomes, tier);
    const totalCharge = tier.baseFeeMonthly + breakdown.reduce((s, l) => s + l.subtotal + l.overageCharge, 0);

    return { tenantId, periodStart, periodEnd, outcomes, totalCharge: Math.round(totalCharge * 100) / 100, breakdown };
  }

  async generateInvoice(tenantId: string, periodStart: string, periodEnd: string): Promise<Invoice> {
    const pool = getPool();
    const id = randomUUID();
    const usage = await this.getUsagePeriod(tenantId, periodStart, periodEnd);
    const tier = await this.getTenantTier(tenantId);

    const invoice: Invoice = {
      id,
      tenantId,
      periodStart,
      periodEnd,
      lineItems: usage.breakdown,
      subtotal: usage.breakdown.reduce((s, l) => s + l.subtotal + l.overageCharge, 0),
      baseFee: tier.baseFeeMonthly,
      total: usage.totalCharge,
      currency: "USD",
      status: "draft",
      dueDate: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    };

    await pool.query(
      `INSERT INTO invoices (id, tenant_id, period_start, period_end, line_items, subtotal, base_fee, total, currency, status, due_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, tenantId, periodStart, periodEnd, JSON.stringify(usage.breakdown), invoice.subtotal, tier.baseFeeMonthly, invoice.total, "USD", "draft", invoice.dueDate],
    );

    logger.info(`Generated invoice ${id} for tenant ${tenantId}: $${invoice.total}`);
    return invoice;
  }

  async issueInvoice(invoiceId: string): Promise<Invoice> {
    const pool = getPool();
    await pool.query(
      `UPDATE invoices SET status = 'issued', issued_at = NOW() WHERE id = $1`,
      [invoiceId],
    );
    const invoice = await this.getInvoice(invoiceId);
    if (invoice) {
      getEventBus().emit("billing.invoice_issued", { invoiceId, tenantId: invoice.tenantId, total: invoice.total });
    }
    return invoice!;
  }

  async markPaid(invoiceId: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE invoices SET status = 'paid', paid_at = NOW() WHERE id = $1`,
      [invoiceId],
    );
  }

  async getInvoice(id: string): Promise<Invoice | null> {
    const pool = getPool();
    const { rows } = await pool.query(`SELECT * FROM invoices WHERE id = $1`, [id]);
    if (rows.length === 0) return null;
    return this.rowToInvoice(rows[0]);
  }

  async listInvoices(tenantId: string, limit = 12): Promise<Invoice[]> {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT * FROM invoices WHERE tenant_id = $1 ORDER BY period_start DESC LIMIT $2`,
      [tenantId, limit],
    );
    return rows.map((r: Record<string, unknown>) => this.rowToInvoice(r));
  }

  async getDashboardData(tenantId: string): Promise<{
    currentPeriod: UsagePeriod;
    projectedTotal: number;
    topOutcomes: Array<{ type: OutcomeType; count: number; charge: number }>;
    trend: Array<{ month: string; total: number }>;
  }> {
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString();

    const currentPeriod = await this.getUsagePeriod(tenantId, periodStart, periodEnd);

    // Project full-month total based on day-of-month progress
    const dayOfMonth = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const projectedTotal = Math.round((currentPeriod.totalCharge / dayOfMonth) * daysInMonth * 100) / 100;

    const topOutcomes = currentPeriod.breakdown
      .filter((l) => l.quantity > 0)
      .sort((a, b) => (b.subtotal + b.overageCharge) - (a.subtotal + a.overageCharge))
      .slice(0, 5)
      .map((l) => ({ type: l.type, count: l.quantity, charge: l.subtotal + l.overageCharge }));

    // Mock trend data
    const trend: Array<{ month: string; total: number }> = [];
    for (let i = 5; i >= 0; i--) {
      const m = new Date(now.getFullYear(), now.getMonth() - i, 1);
      trend.push({
        month: m.toISOString().slice(0, 7),
        total: Math.round((currentPeriod.totalCharge * (0.8 + Math.random() * 0.4)) * 100) / 100,
      });
    }

    return { currentPeriod, projectedTotal, topOutcomes, trend };
  }

  // ── Tier Management ───────────────────────────────────────────────

  async getTenantTier(tenantId: string): Promise<PricingTier> {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT tier_id FROM tenant_billing WHERE tenant_id = $1`,
      [tenantId],
    );
    const tierId = (rows[0]?.tier_id as string) ?? "starter";
    return DEFAULT_TIERS.find((t) => t.id === tierId) ?? DEFAULT_TIERS[0]!;
  }

  async setTenantTier(tenantId: string, tierId: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      `INSERT INTO tenant_billing (tenant_id, tier_id) VALUES ($1, $2)
       ON CONFLICT (tenant_id) DO UPDATE SET tier_id = $2, updated_at = NOW()`,
      [tenantId, tierId],
    );
  }

  getAvailableTiers(): PricingTier[] {
    return DEFAULT_TIERS;
  }

  // ── Internal ──────────────────────────────────────────────────────

  private calculateCharges(
    outcomes: Record<OutcomeType, { count: number; totalQuantity: number }>,
    tier: PricingTier,
  ): ChargeLineItem[] {
    const lineItems: ChargeLineItem[] = [];

    for (const pricing of tier.outcomes) {
      const usage = outcomes[pricing.type];
      if (!usage) continue;

      const included = tier.includedOutcomes[pricing.type] ?? 0;
      const totalQty = usage.totalQuantity;
      const overage = Math.max(0, totalQty - included);
      const overageRate = tier.overageRate[pricing.type] ?? pricing.unitPrice;

      const subtotal = Math.min(totalQty, included) * pricing.unitPrice;
      const overageCharge = overage * overageRate;

      lineItems.push({
        type: pricing.type,
        description: `${pricing.type.replace(/_/g, " ")} (${pricing.unit})`,
        quantity: totalQty,
        unitPrice: pricing.unitPrice,
        subtotal: Math.round(subtotal * 100) / 100,
        included,
        overage,
        overageCharge: Math.round(overageCharge * 100) / 100,
      });
    }

    return lineItems;
  }

  private rowToInvoice(row: Record<string, unknown>): Invoice {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      periodStart: String(row.period_start),
      periodEnd: String(row.period_end),
      lineItems: typeof row.line_items === "string" ? JSON.parse(row.line_items) : row.line_items as ChargeLineItem[],
      subtotal: row.subtotal as number,
      baseFee: row.base_fee as number,
      total: row.total as number,
      currency: row.currency as string,
      status: row.status as Invoice["status"],
      issuedAt: row.issued_at ? String(row.issued_at) : undefined,
      dueDate: row.due_date ? String(row.due_date) : undefined,
      paidAt: row.paid_at ? String(row.paid_at) : undefined,
    };
  }
}

// ── Singleton ───────────────────────────────────────────────────────

let instance: OutcomeBillingManager | null = null;

export function getOutcomeBillingManager(): OutcomeBillingManager {
  if (!instance) instance = new OutcomeBillingManager();
  return instance;
}
