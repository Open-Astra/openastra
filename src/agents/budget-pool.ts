import { getPool } from "../config/postgres.js";
import { getEventBus } from "../events/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("budget-pool");

// ── Types ────────────────────────────────────────────────────────────

export interface WorkspaceBudget {
  workspaceId: string;
  totalBudgetUsd: number;
  spentUsd: number;
  remainingUsd: number;
  periodStart: string;
  periodEnd?: string;
  perAgentCapUsd?: number;
}

export interface BudgetTransaction {
  id: string;
  workspaceId: string;
  agentId: string;
  amountUsd: number;
  description?: string;
  inferenceTokens?: number;
  createdAt: string;
}

// ── Functions ────────────────────────────────────────────────────────

export async function getBudget(workspaceId: string): Promise<WorkspaceBudget | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT workspace_id, total_budget_usd, spent_usd, period_start, period_end, per_agent_cap_usd
     FROM workspace_budgets WHERE workspace_id = $1`,
    [workspaceId],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  const total = parseFloat(r.total_budget_usd);
  const spent = parseFloat(r.spent_usd);
  return {
    workspaceId: r.workspace_id,
    totalBudgetUsd: total,
    spentUsd: spent,
    remainingUsd: total - spent,
    periodStart: r.period_start,
    periodEnd: r.period_end ?? undefined,
    perAgentCapUsd: r.per_agent_cap_usd ? parseFloat(r.per_agent_cap_usd) : undefined,
  };
}

export async function createBudget(
  workspaceId: string,
  totalBudgetUsd: number,
  perAgentCapUsd?: number,
  periodEnd?: Date,
): Promise<WorkspaceBudget> {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO workspace_budgets (workspace_id, total_budget_usd, per_agent_cap_usd, period_end)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id) DO UPDATE SET
       total_budget_usd = EXCLUDED.total_budget_usd,
       per_agent_cap_usd = EXCLUDED.per_agent_cap_usd,
       period_end = EXCLUDED.period_end,
       updated_at = now()
     RETURNING workspace_id, total_budget_usd, spent_usd, period_start, period_end, per_agent_cap_usd`,
    [workspaceId, totalBudgetUsd, perAgentCapUsd ?? null, periodEnd ?? null],
  );
  const r = rows[0];
  const total = parseFloat(r.total_budget_usd);
  const spent = parseFloat(r.spent_usd);
  return {
    workspaceId: r.workspace_id,
    totalBudgetUsd: total,
    spentUsd: spent,
    remainingUsd: total - spent,
    periodStart: r.period_start,
    periodEnd: r.period_end ?? undefined,
    perAgentCapUsd: r.per_agent_cap_usd ? parseFloat(r.per_agent_cap_usd) : undefined,
  };
}

export async function recordSpend(
  workspaceId: string,
  agentId: string,
  amountUsd: number,
  description?: string,
  tokens?: number,
): Promise<{ allowed: boolean; remaining: number }> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock the budget row
    const { rows: budgetRows } = await client.query(
      `SELECT total_budget_usd, spent_usd, per_agent_cap_usd
       FROM workspace_budgets WHERE workspace_id = $1 FOR UPDATE`,
      [workspaceId],
    );
    if (budgetRows.length === 0) {
      await client.query("ROLLBACK");
      return { allowed: false, remaining: 0 };
    }

    const total = parseFloat(budgetRows[0].total_budget_usd);
    const spent = parseFloat(budgetRows[0].spent_usd);
    const perAgentCap = budgetRows[0].per_agent_cap_usd
      ? parseFloat(budgetRows[0].per_agent_cap_usd)
      : null;
    const remaining = total - spent;

    // Check workspace total
    if (amountUsd > remaining) {
      await client.query("ROLLBACK");
      return { allowed: false, remaining };
    }

    // Check per-agent cap
    if (perAgentCap !== null) {
      const { rows: agentRows } = await client.query(
        `SELECT COALESCE(SUM(amount_usd), 0) AS agent_spent
         FROM budget_transactions WHERE workspace_id = $1 AND agent_id = $2`,
        [workspaceId, agentId],
      );
      const agentSpent = parseFloat(agentRows[0].agent_spent);
      if (agentSpent + amountUsd > perAgentCap) {
        await client.query("ROLLBACK");
        return { allowed: false, remaining };
      }
    }

    // Insert transaction and update spent
    await client.query(
      `INSERT INTO budget_transactions (workspace_id, agent_id, amount_usd, description, inference_tokens)
       VALUES ($1, $2, $3, $4, $5)`,
      [workspaceId, agentId, amountUsd, description ?? null, tokens ?? null],
    );
    await client.query(
      `UPDATE workspace_budgets SET spent_usd = spent_usd + $2, updated_at = now()
       WHERE workspace_id = $1`,
      [workspaceId, amountUsd],
    );

    await client.query("COMMIT");

    const newRemaining = remaining - amountUsd;

    // Emit events
    const bus = getEventBus();
    try {
      bus.emit("budget.spend" as never, {
        workspaceId,
        agentId,
        amountUsd,
        remaining: newRemaining,
        timestamp: Date.now(),
      } as never);

      // Emit exhausted if remaining < 1% of total
      if (newRemaining < total * 0.01) {
        bus.emit("budget.exhausted" as never, {
          workspaceId,
          remaining: newRemaining,
          totalBudgetUsd: total,
          timestamp: Date.now(),
        } as never);
      }
    } catch {
      log.warn("Failed to emit budget event");
    }

    return { allowed: true, remaining: newRemaining };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getAgentSpend(workspaceId: string, agentId: string): Promise<number> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount_usd), 0) AS total
     FROM budget_transactions WHERE workspace_id = $1 AND agent_id = $2`,
    [workspaceId, agentId],
  );
  return parseFloat(rows[0].total);
}

export async function getTransactions(
  workspaceId: string,
  opts?: { agentId?: string; limit?: number },
): Promise<BudgetTransaction[]> {
  const pool = getPool();
  const conditions = ["workspace_id = $1"];
  const params: unknown[] = [workspaceId];

  if (opts?.agentId) {
    params.push(opts.agentId);
    conditions.push(`agent_id = $${params.length}`);
  }

  const limit = opts?.limit ?? 100;
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT id, workspace_id, agent_id, amount_usd, description, inference_tokens, created_at
     FROM budget_transactions
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params,
  );

  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    agentId: r.agent_id,
    amountUsd: parseFloat(r.amount_usd),
    description: r.description ?? undefined,
    inferenceTokens: r.inference_tokens ?? undefined,
    createdAt: r.created_at,
  }));
}

export async function checkBudget(
  workspaceId: string,
  agentId?: string,
): Promise<{ withinBudget: boolean; remaining: number; agentRemaining?: number }> {
  const budget = await getBudget(workspaceId);
  if (!budget) {
    return { withinBudget: true, remaining: Infinity };
  }

  const remaining = budget.remainingUsd;
  let agentRemaining: number | undefined;

  if (agentId && budget.perAgentCapUsd !== undefined) {
    const agentSpent = await getAgentSpend(workspaceId, agentId);
    agentRemaining = budget.perAgentCapUsd - agentSpent;
  }

  const withinBudget = remaining > 0 && (agentRemaining === undefined || agentRemaining > 0);

  return { withinBudget, remaining, agentRemaining };
}
