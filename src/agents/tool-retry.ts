// ── Adaptive Tool Retry ────────────────────────────────────────────────
// Exponential backoff + jitter retry for tool failures.
// Per-tool retry budget; exhausted calls go to dead-letter table.

import { getPool } from "../config/postgres.js";
import { randomUUID } from "node:crypto";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("tool-retry");

export interface RetryBudget {
  toolName: string;
  workspaceId: string;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
}

const DEFAULT_BUDGET: Omit<RetryBudget, "toolName" | "workspaceId"> = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  jitter: true,
};

export async function getRetryBudget(
  toolName: string,
  workspaceId: string,
): Promise<RetryBudget> {
  const { rows } = await getPool().query<RetryBudget>(
    `SELECT tool_name AS "toolName", workspace_id AS "workspaceId",
            max_attempts AS "maxAttempts", base_delay_ms AS "baseDelayMs",
            max_delay_ms AS "maxDelayMs", jitter
     FROM tool_retry_budgets WHERE tool_name = $1 AND workspace_id = $2`,
    [toolName, workspaceId],
  ).catch(() => ({ rows: [] as RetryBudget[] }));
  return rows[0] ?? { toolName, workspaceId, ...DEFAULT_BUDGET };
}

export async function upsertRetryBudget(budget: RetryBudget): Promise<void> {
  await getPool().query(
    `INSERT INTO tool_retry_budgets
       (id, workspace_id, tool_name, max_attempts, base_delay_ms, max_delay_ms, jitter)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (workspace_id, tool_name) DO UPDATE
       SET max_attempts = EXCLUDED.max_attempts,
           base_delay_ms = EXCLUDED.base_delay_ms,
           max_delay_ms = EXCLUDED.max_delay_ms,
           jitter = EXCLUDED.jitter,
           updated_at = NOW()`,
    [randomUUID(), budget.workspaceId, budget.toolName, budget.maxAttempts,
     budget.baseDelayMs, budget.maxDelayMs, budget.jitter],
  );
}

function computeDelay(attempt: number, budget: RetryBudget): number {
  const base = budget.baseDelayMs * Math.pow(2, attempt);
  const capped = Math.min(base, budget.maxDelayMs);
  if (!budget.jitter) return capped;
  return capped * (0.5 + Math.random() * 0.5);
}

/** Execute a tool function with adaptive retry. Sends to dead-letter on exhaustion. */
export async function withToolRetry<T>(
  toolName: string,
  workspaceId: string,
  sessionId: string,
  agentId: string,
  args: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const budget = await getRetryBudget(toolName, workspaceId);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < budget.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < budget.maxAttempts - 1) {
        const delay = computeDelay(attempt, budget);
        logger.warn(`Tool "${toolName}" attempt ${attempt + 1} failed, retrying in ${Math.round(delay)}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  // Exhausted — send to dead-letter
  const errMsg = lastError?.message ?? "Unknown error";
  await sendToDeadLetter(toolName, workspaceId, sessionId, agentId, args, budget.maxAttempts, errMsg);
  throw lastError ?? new Error(`Tool "${toolName}" failed after ${budget.maxAttempts} attempts`);
}

async function sendToDeadLetter(
  toolName: string,
  workspaceId: string,
  sessionId: string,
  agentId: string,
  args: Record<string, unknown>,
  attempts: number,
  lastError: string,
): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO tool_dead_letter
         (id, workspace_id, session_id, agent_id, tool_name, arguments, attempts, last_error)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
      [randomUUID(), workspaceId, sessionId, agentId, toolName, JSON.stringify(args), attempts, lastError],
    );
  } catch (err) {
    logger.error(`Failed to write dead-letter: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function listDeadLetter(
  workspaceId: string,
  limit = 50,
): Promise<unknown[]> {
  const { rows } = await getPool().query(
    `SELECT id, session_id AS "sessionId", agent_id AS "agentId",
            tool_name AS "toolName", arguments, attempts, last_error AS "lastError",
            created_at AS "createdAt"
     FROM tool_dead_letter WHERE workspace_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [workspaceId, limit],
  );
  return rows;
}

export async function clearDeadLetter(id: string, workspaceId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `DELETE FROM tool_dead_letter WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return (rowCount ?? 0) > 0;
}
