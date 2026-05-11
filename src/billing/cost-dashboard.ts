// ── Cost Dashboard ──────────────────────────────────────────────────
// Aggregation and querying for workspace cost breakdowns.
// Reads from billing_usage, computes costs using the cost model,
// and provides snapshot persistence for the daily cron job.

import { getPool } from "../config/postgres.js";
import { estimateCost } from "./cost-model.js";

// ── Types ───────────────────────────────────────────────────────────

export interface CostBreakdown {
  totalTokens: number;
  totalCost: number; // in cents
  byAgent: Array<{ agentId: string; tokens: number; cost: number }>;
  byUser: Array<{ userId: string; tokens: number; cost: number }>;
  byModel: Array<{ modelId: string; tokens: number; cost: number }>;
  trend: Array<{ period: string; tokens: number; cost: number }>;
}

interface BillingUsageRow {
  user_id: string;
  workspace_id: string | null;
  month: string;
  total_prompt_tokens: string;
  total_completion_tokens: string;
  total_tokens: string;
  request_count: number;
  by_agent: Record<string, { prompt?: number; completion?: number; total?: number; count?: number }>;
}

// ── Helpers ─────────────────────────────────────────────────────────

function getMonthKey(date?: Date): string {
  const d = date ?? new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/**
 * Generate an array of YYYY-MM month keys going back `count` months
 * from the current month (inclusive).
 */
function getRecentMonths(count: number): string[] {
  const months: string[] = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(getMonthKey(d));
  }
  return months;
}

// ── Workspace Cost Breakdown ────────────────────────────────────────

export async function getWorkspaceCostBreakdown(
  workspaceId: string | null,
  options?: { months?: number; startDate?: string; endDate?: string },
): Promise<CostBreakdown> {
  const pool = getPool();
  const monthCount = options?.months ?? 3;

  // Determine which months to query
  let months: string[];
  if (options?.startDate && options?.endDate) {
    // Parse date range into month keys
    months = [];
    const start = new Date(options.startDate);
    const end = new Date(options.endDate);
    const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    while (cursor <= end) {
      months.push(getMonthKey(cursor));
      cursor.setMonth(cursor.getMonth() + 1);
    }
    if (months.length === 0) {
      months = [getMonthKey()];
    }
  } else {
    months = getRecentMonths(monthCount);
  }

  // Query billing_usage rows for the relevant months
  let rows: BillingUsageRow[];

  if (workspaceId) {
    const result = await pool.query<BillingUsageRow>(
      `SELECT user_id, workspace_id, month,
              total_prompt_tokens, total_completion_tokens, total_tokens,
              request_count, by_agent
       FROM billing_usage
       WHERE workspace_id = $1 AND month = ANY($2)
       ORDER BY month DESC`,
      [workspaceId, months],
    );
    rows = result.rows;
  } else {
    const result = await pool.query<BillingUsageRow>(
      `SELECT user_id, workspace_id, month,
              total_prompt_tokens, total_completion_tokens, total_tokens,
              request_count, by_agent
       FROM billing_usage
       WHERE month = ANY($1)
       ORDER BY month DESC`,
      [months],
    );
    rows = result.rows;
  }

  // Handle empty results gracefully
  if (rows.length === 0) {
    return {
      totalTokens: 0,
      totalCost: 0,
      byAgent: [],
      byUser: [],
      byModel: [],
      trend: months.map((m) => ({ period: m, tokens: 0, cost: 0 })),
    };
  }

  // Aggregate totals
  let totalTokens = 0;
  let totalCost = 0;

  const agentMap = new Map<string, { tokens: number; prompt: number; completion: number }>();
  const userMap = new Map<string, { tokens: number; prompt: number; completion: number }>();
  const trendMap = new Map<string, { tokens: number; prompt: number; completion: number }>();

  for (const row of rows) {
    const promptTokens = parseInt(String(row.total_prompt_tokens), 10) || 0;
    const completionTokens = parseInt(String(row.total_completion_tokens), 10) || 0;
    const tokens = parseInt(String(row.total_tokens), 10) || 0;

    totalTokens += tokens;

    // Estimate cost for this row using overall prompt/completion split
    const rowCost = estimateCost({ promptTokens, completionTokens }, "gpt-4o");
    totalCost += rowCost;

    // Aggregate by user
    const userEntry = userMap.get(row.user_id) ?? { tokens: 0, prompt: 0, completion: 0 };
    userEntry.tokens += tokens;
    userEntry.prompt += promptTokens;
    userEntry.completion += completionTokens;
    userMap.set(row.user_id, userEntry);

    // Aggregate by agent from JSONB
    const byAgent = row.by_agent ?? {};
    for (const [agentId, bucket] of Object.entries(byAgent)) {
      const agentEntry = agentMap.get(agentId) ?? { tokens: 0, prompt: 0, completion: 0 };
      agentEntry.tokens += (bucket.total ?? 0);
      agentEntry.prompt += (bucket.prompt ?? 0);
      agentEntry.completion += (bucket.completion ?? 0);
      agentMap.set(agentId, agentEntry);
    }

    // Aggregate trend by month
    const trendEntry = trendMap.get(row.month) ?? { tokens: 0, prompt: 0, completion: 0 };
    trendEntry.tokens += tokens;
    trendEntry.prompt += promptTokens;
    trendEntry.completion += completionTokens;
    trendMap.set(row.month, trendEntry);
  }

  // Build byAgent with cost estimation
  const byAgent = Array.from(agentMap.entries())
    .map(([agentId, data]) => ({
      agentId,
      tokens: data.tokens,
      cost: estimateCost({ promptTokens: data.prompt, completionTokens: data.completion }, "gpt-4o"),
    }))
    .sort((a, b) => b.cost - a.cost);

  // Build byUser with cost estimation
  const byUser = Array.from(userMap.entries())
    .map(([userId, data]) => ({
      userId,
      tokens: data.tokens,
      cost: estimateCost({ promptTokens: data.prompt, completionTokens: data.completion }, "gpt-4o"),
    }))
    .sort((a, b) => b.cost - a.cost);

  // Build trend sorted chronologically
  const trend = months
    .map((period) => {
      const data = trendMap.get(period) ?? { tokens: 0, prompt: 0, completion: 0 };
      return {
        period,
        tokens: data.tokens,
        cost: estimateCost({ promptTokens: data.prompt, completionTokens: data.completion }, "gpt-4o"),
      };
    })
    .sort((a, b) => a.period.localeCompare(b.period));

  // Recalculate totalCost as sum of user costs for consistency
  totalCost = byUser.reduce((sum, u) => sum + u.cost, 0);

  // Note: byModel is empty because billing_usage does not track per-model usage.
  // The cost_snapshots table has a by_model JSONB column that snapshotCosts() can populate
  // once model tracking is added to the billing_usage table.
  const byModel: Array<{ modelId: string; tokens: number; cost: number }> = [];

  return { totalTokens, totalCost, byAgent, byUser, byModel, trend };
}

// ── Snapshot Costs ──────────────────────────────────────────────────

/**
 * Aggregate billing_usage into cost_snapshots for the current day.
 * Called by the daily cron job. Upserts to avoid duplicates.
 */
export async function snapshotCosts(): Promise<void> {
  const pool = getPool();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const currentMonth = getMonthKey();

  // Get all billing_usage rows for the current month
  const { rows } = await pool.query<BillingUsageRow>(
    `SELECT user_id, workspace_id, month,
            total_prompt_tokens, total_completion_tokens, total_tokens,
            request_count, by_agent
     FROM billing_usage
     WHERE month = $1`,
    [currentMonth],
  );

  if (rows.length === 0) return;

  // Group by workspace
  const workspaceGroups = new Map<string | null, BillingUsageRow[]>();
  for (const row of rows) {
    const wsId = row.workspace_id ?? null;
    const group = workspaceGroups.get(wsId) ?? [];
    group.push(row);
    workspaceGroups.set(wsId, group);
  }

  for (const [wsId, wsRows] of workspaceGroups) {
    let totalTokens = 0;
    let totalCost = 0;
    const agentAgg: Record<string, { tokens: number; cost: number }> = {};
    const userAgg: Record<string, { tokens: number; cost: number }> = {};

    for (const row of wsRows) {
      const promptTokens = parseInt(String(row.total_prompt_tokens), 10) || 0;
      const completionTokens = parseInt(String(row.total_completion_tokens), 10) || 0;
      const tokens = parseInt(String(row.total_tokens), 10) || 0;
      const rowCost = estimateCost({ promptTokens, completionTokens }, "gpt-4o");

      totalTokens += tokens;
      totalCost += rowCost;

      // Aggregate per user
      const existing = userAgg[row.user_id] ?? { tokens: 0, cost: 0 };
      existing.tokens += tokens;
      existing.cost += rowCost;
      userAgg[row.user_id] = existing;

      // Aggregate per agent from JSONB
      const byAgent = row.by_agent ?? {};
      for (const [agentId, bucket] of Object.entries(byAgent)) {
        const agentEntry = agentAgg[agentId] ?? { tokens: 0, cost: 0 };
        const agentPrompt = bucket.prompt ?? 0;
        const agentCompletion = bucket.completion ?? 0;
        agentEntry.tokens += (bucket.total ?? 0);
        agentEntry.cost += estimateCost(
          { promptTokens: agentPrompt, completionTokens: agentCompletion },
          "gpt-4o",
        );
        agentAgg[agentId] = agentEntry;
      }
    }

    // Convert totalCost from cents to dollars for the NUMERIC(12,4) column
    const totalCostDollars = totalCost / 100;

    await pool.query(
      `INSERT INTO cost_snapshots (workspace_id, period, total_tokens, total_cost, by_agent, by_user, by_model)
       VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb)
       ON CONFLICT (workspace_id, period)
       DO UPDATE SET
         total_tokens = $3,
         total_cost = $4,
         by_agent = $5,
         by_user = $6,
         created_at = NOW()`,
      [
        wsId,
        today,
        totalTokens,
        totalCostDollars,
        JSON.stringify(agentAgg),
        JSON.stringify(userAgg),
      ],
    );
  }
}
