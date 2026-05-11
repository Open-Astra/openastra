import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

// ── Scheduled Agent Tasks ──────────────────────────────────────────
// CRUD for scheduled tasks that run agent prompts at specific times
// or on cron intervals.

const log = createLogger("scheduled-tasks");

export interface ScheduledTask {
  id: string;
  uid: string;
  workspaceId: string | null;
  agentId: string;
  cronExpression: string | null;
  runAt: string | null;
  prompt: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  runCount: number;
  maxRuns: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateScheduledTaskInput {
  workspaceId?: string;
  agentId: string;
  prompt: string;
  cronExpression?: string;
  runAt?: string;
  maxRuns?: number;
}

function rowToTask(row: Record<string, unknown>): ScheduledTask {
  return {
    id: row.id as string,
    uid: row.uid as string,
    workspaceId: (row.workspace_id as string) ?? null,
    agentId: row.agent_id as string,
    cronExpression: (row.cron_expression as string) ?? null,
    runAt: row.run_at ? String(row.run_at) : null,
    prompt: row.prompt as string,
    enabled: row.enabled as boolean,
    lastRunAt: row.last_run_at ? String(row.last_run_at) : null,
    nextRunAt: row.next_run_at ? String(row.next_run_at) : null,
    runCount: row.run_count as number,
    maxRuns: (row.max_runs as number) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * Compute the next run time from a cron expression.
 * Simple parser supporting: minute hour day-of-month month day-of-week
 * For production use, a full cron parser should be used. This computes
 * "next hour" as a simple approximation for MVP.
 */
function computeNextRun(cronExpression: string): Date {
  // Simple implementation: parse the cron and compute next occurrence
  // For now, use a basic approach — schedule 1 hour from now as fallback
  const parts = cronExpression.trim().split(/\s+/);
  const now = new Date();

  if (parts.length >= 2) {
    const minute = parts[0] === "*" ? now.getMinutes() : parseInt(parts[0], 10);
    const hour = parts[1] === "*" ? now.getHours() : parseInt(parts[1], 10);

    const next = new Date(now);
    next.setSeconds(0, 0);
    next.setMinutes(minute);
    next.setHours(hour);

    // If the computed time is in the past, advance by 1 day
    if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1);
    }
    return next;
  }

  // Fallback: 1 hour from now
  return new Date(now.getTime() + 3_600_000);
}

export async function createScheduledTask(
  uid: string,
  input: CreateScheduledTaskInput,
): Promise<ScheduledTask> {
  const pool = getPool();
  const id = randomUUID();

  let nextRunAt: Date | null = null;
  if (input.cronExpression) {
    nextRunAt = computeNextRun(input.cronExpression);
  } else if (input.runAt) {
    nextRunAt = new Date(input.runAt);
  }

  const result = await pool.query(
    `INSERT INTO scheduled_tasks (id, uid, workspace_id, agent_id, cron_expression, run_at, prompt, next_run_at, max_runs)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      id,
      uid,
      input.workspaceId ?? null,
      input.agentId,
      input.cronExpression ?? null,
      input.runAt ?? null,
      input.prompt,
      nextRunAt?.toISOString() ?? null,
      input.maxRuns ?? null,
    ],
  );

  return rowToTask(result.rows[0] as Record<string, unknown>);
}

export async function getScheduledTasks(uid: string, workspaceId?: string): Promise<ScheduledTask[]> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT * FROM scheduled_tasks
     WHERE uid = $1 AND ($2::text IS NULL OR workspace_id = $2)
     ORDER BY created_at DESC`,
    [uid, workspaceId ?? null],
  );
  return result.rows.map((r: unknown) => rowToTask(r as Record<string, unknown>));
}

export async function deleteScheduledTask(uid: string, taskId: string): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    `DELETE FROM scheduled_tasks WHERE id = $1 AND uid = $2 RETURNING id`,
    [taskId, uid],
  );
  return result.rowCount !== null && result.rowCount > 0;
}

export async function getNextDueTasks(limit = 50): Promise<ScheduledTask[]> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT * FROM scheduled_tasks
     WHERE enabled = true
       AND next_run_at <= NOW()
       AND (max_runs IS NULL OR run_count < max_runs)
     ORDER BY next_run_at ASC
     LIMIT $1`,
    [limit],
  );
  return result.rows.map((r: unknown) => rowToTask(r as Record<string, unknown>));
}

export async function markTaskRun(taskId: string): Promise<void> {
  const pool = getPool();

  // First get the task to compute next run
  const taskResult = await pool.query(
    `SELECT cron_expression, max_runs, run_count FROM scheduled_tasks WHERE id = $1`,
    [taskId],
  );
  if (taskResult.rows.length === 0) return;

  const task = taskResult.rows[0] as { cron_expression: string | null; max_runs: number | null; run_count: number };
  const newRunCount = task.run_count + 1;

  // Compute next run time for cron tasks; disable one-shot tasks
  let nextRunAt: string | null = null;
  let enabled = true;

  if (task.cron_expression) {
    // Check if max_runs reached
    if (task.max_runs !== null && newRunCount >= task.max_runs) {
      enabled = false;
    } else {
      nextRunAt = computeNextRun(task.cron_expression).toISOString();
    }
  } else {
    // One-shot task — disable after running
    enabled = false;
  }

  await pool.query(
    `UPDATE scheduled_tasks
     SET last_run_at = NOW(),
         run_count = $2,
         next_run_at = $3,
         enabled = $4,
         updated_at = NOW()
     WHERE id = $1`,
    [taskId, newRunCount, nextRunAt, enabled],
  );

  log.dim(`Task ${taskId} marked as run (count: ${newRunCount}, next: ${nextRunAt ?? "none"})`);
}

export async function getScheduledTaskById(uid: string, taskId: string): Promise<ScheduledTask | null> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT * FROM scheduled_tasks WHERE id = $1 AND uid = $2`,
    [taskId, uid],
  );
  if (result.rows.length === 0) return null;
  return rowToTask(result.rows[0] as Record<string, unknown>);
}
