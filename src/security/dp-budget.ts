// ── Differential Privacy Budget Tracking ─────────────────────────────
// Tracks epsilon budget consumption per user per workspace.
// Each memory search query consumes epsilon (default 0.1 per query).
// When the budget is exhausted, further queries are rejected.

import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("dp-budget");

const DEFAULT_EPSILON_COST = 0.1;
const DEFAULT_EPSILON_LIMIT = 10;

// ── Types ─────────────────────────────────────────────────────────────

export interface DpBudgetStatus {
  workspaceId: string;
  uid: string;
  epsilonUsed: number;
  epsilonLimit: number;
  epsilonRemaining: number;
  queriesCount: number;
  lastQueryAt: string | null;
  resetAt: string | null;
  exhausted: boolean;
}

// ── DB Row ────────────────────────────────────────────────────────────

interface BudgetRow {
  epsilon_used: string;
  epsilon_limit: string;
  queries_count: number;
  last_query_at: string | null;
  reset_at: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Ensure a budget row exists for (workspaceId, uid).
 * Returns the current row after ensuring it exists.
 */
async function ensureBudgetRow(
  workspaceId: string,
  uid: string,
): Promise<BudgetRow> {
  const pool = getPool();

  const { rows } = await pool.query<BudgetRow>(
    `INSERT INTO dp_budgets (workspace_id, uid)
     VALUES ($1, $2)
     ON CONFLICT (workspace_id, uid) DO NOTHING
     RETURNING epsilon_used, epsilon_limit, queries_count, last_query_at, reset_at`,
    [workspaceId, uid],
  );

  if (rows.length > 0) return rows[0]!;

  // Row already existed — fetch it
  const existing = await pool.query<BudgetRow>(
    `SELECT epsilon_used, epsilon_limit, queries_count, last_query_at, reset_at
     FROM dp_budgets
     WHERE workspace_id = $1 AND uid = $2`,
    [workspaceId, uid],
  );
  return existing.rows[0]!;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Check whether a user has remaining DP budget for a query.
 * Does NOT consume budget. Returns { allowed, remaining }.
 */
export async function checkDpBudget(
  workspaceId: string,
  uid: string,
  epsilonCost: number = DEFAULT_EPSILON_COST,
): Promise<{ allowed: boolean; remaining: number }> {
  try {
    const row = await ensureBudgetRow(workspaceId, uid);

    const used = parseFloat(row.epsilon_used);
    const limit = parseFloat(row.epsilon_limit);
    const remaining = Math.max(0, limit - used);
    const allowed = remaining >= epsilonCost;

    if (!allowed) {
      log.warn(
        `DP budget exhausted: uid=${uid} workspace=${workspaceId} used=${used} limit=${limit}`,
      );
    }

    return { allowed, remaining };
  } catch (err) {
    log.error("checkDpBudget error:", err);
    // Fail-open: if we can't check, allow the query
    return { allowed: true, remaining: DEFAULT_EPSILON_LIMIT };
  }
}

/**
 * Consume epsilon from the user's DP budget.
 * Creates the budget row if it doesn't exist.
 */
export async function consumeDpBudget(
  workspaceId: string,
  uid: string,
  epsilonCost: number = DEFAULT_EPSILON_COST,
): Promise<void> {
  const pool = getPool();

  await pool.query(
    `INSERT INTO dp_budgets (workspace_id, uid, epsilon_used, queries_count, last_query_at)
     VALUES ($1, $2, $3, 1, NOW())
     ON CONFLICT (workspace_id, uid) DO UPDATE
       SET epsilon_used  = dp_budgets.epsilon_used + $3,
           queries_count = dp_budgets.queries_count + 1,
           last_query_at = NOW()`,
    [workspaceId, uid, epsilonCost],
  );
}

/**
 * Return the full DP budget status for a user.
 */
export async function getDpBudgetStatus(
  workspaceId: string,
  uid: string,
): Promise<DpBudgetStatus> {
  const row = await ensureBudgetRow(workspaceId, uid);

  const epsilonUsed = parseFloat(row.epsilon_used);
  const epsilonLimit = parseFloat(row.epsilon_limit);
  const epsilonRemaining = Math.max(0, epsilonLimit - epsilonUsed);

  return {
    workspaceId,
    uid,
    epsilonUsed,
    epsilonLimit,
    epsilonRemaining,
    queriesCount: row.queries_count,
    lastQueryAt: row.last_query_at,
    resetAt: row.reset_at,
    exhausted: epsilonRemaining <= 0,
  };
}

/**
 * Reset the DP budget for a user (admin operation).
 */
export async function resetDpBudget(
  workspaceId: string,
  uid: string,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO dp_budgets (workspace_id, uid, epsilon_used, queries_count, last_query_at, reset_at)
     VALUES ($1, $2, 0, 0, NULL, NOW() + INTERVAL '1 day' * 30)
     ON CONFLICT (workspace_id, uid) DO UPDATE
       SET epsilon_used  = 0,
           queries_count = 0,
           last_query_at = NULL,
           reset_at      = NOW() + INTERVAL '1 day' * 30`,
    [workspaceId, uid],
  );
  log.info(`DP budget reset: uid=${uid} workspace=${workspaceId}`);
}
