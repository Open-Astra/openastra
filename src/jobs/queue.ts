import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("job-queue");

export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface Job {
  id: string;
  workspaceId: string;
  type: string;
  status: JobStatus;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  progress: number;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  workerId: string | null;
  maxRetries: number;
  retryCount: number;
  timeoutSeconds: number;
}

export interface EnqueueOptions {
  maxRetries?: number;
  timeoutSeconds?: number;
}

export interface ListJobsOptions {
  status?: JobStatus;
  limit?: number;
}

function rowToJob(row: Record<string, unknown>): Job {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    type: row.type as string,
    status: row.status as JobStatus,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    result: (row.result ?? null) as Record<string, unknown> | null,
    error: (row.error ?? null) as string | null,
    progress: row.progress as number,
    createdAt: row.created_at as Date,
    startedAt: (row.started_at ?? null) as Date | null,
    completedAt: (row.completed_at ?? null) as Date | null,
    workerId: (row.worker_id ?? null) as string | null,
    maxRetries: row.max_retries as number,
    retryCount: row.retry_count as number,
    timeoutSeconds: row.timeout_seconds as number,
  };
}

export async function enqueueJob(
  type: string,
  payload: Record<string, unknown>,
  workspaceId: string,
  opts: EnqueueOptions = {},
): Promise<Job> {
  const { rows } = await getPool().query(
    `INSERT INTO job_queue (workspace_id, type, payload, max_retries, timeout_seconds)
     VALUES ($1, $2, $3::jsonb, $4, $5) RETURNING *`,
    [workspaceId, type, JSON.stringify(payload), opts.maxRetries ?? 3, opts.timeoutSeconds ?? 300],
  );
  const job = rowToJob(rows[0]);
  log.dim(`Enqueued job ${job.id} type=${type}`);
  return job;
}

export async function claimNextJob(workerId: string): Promise<Job | null> {
  const { rows } = await getPool().query(
    `UPDATE job_queue SET status = 'running', started_at = NOW(), worker_id = $1
     WHERE id = (SELECT id FROM job_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [workerId],
  );
  return rows.length > 0 ? rowToJob(rows[0]) : null;
}

export async function updateJobProgress(id: string, progress: number): Promise<void> {
  await getPool().query(
    "UPDATE job_queue SET progress = $1 WHERE id = $2",
    [Math.max(0, Math.min(100, progress)), id],
  );
}

export async function completeJob(id: string, result: Record<string, unknown>): Promise<void> {
  await getPool().query(
    `UPDATE job_queue SET status = 'completed', result = $2::jsonb, progress = 100, completed_at = NOW() WHERE id = $1`,
    [id, JSON.stringify(result)],
  );
}

export async function failJob(id: string, error: string, shouldRetry = false): Promise<void> {
  if (shouldRetry) {
    await getPool().query(
      `UPDATE job_queue SET status = 'pending', error = $2, retry_count = retry_count + 1, started_at = NULL, worker_id = NULL WHERE id = $1`,
      [id, error],
    );
  } else {
    await getPool().query(
      `UPDATE job_queue SET status = 'failed', error = $2, retry_count = retry_count + 1, completed_at = NOW() WHERE id = $1`,
      [id, error],
    );
  }
}

export async function cancelJob(id: string, workspaceId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE job_queue SET status = 'cancelled', completed_at = NOW()
     WHERE id = $1 AND workspace_id = $2 AND status = 'pending'`,
    [id, workspaceId],
  );
  return (rowCount ?? 0) > 0;
}

export async function getJob(id: string, workspaceId: string): Promise<Job | null> {
  const { rows } = await getPool().query(
    "SELECT * FROM job_queue WHERE id = $1 AND workspace_id = $2",
    [id, workspaceId],
  );
  return rows.length > 0 ? rowToJob(rows[0]) : null;
}

export async function listJobs(workspaceId: string, opts: ListJobsOptions = {}): Promise<Job[]> {
  const conditions: string[] = ["workspace_id = $1"];
  const values: unknown[] = [workspaceId];
  let paramIdx = 2;

  if (opts.status) {
    conditions.push(`status = $${paramIdx++}`);
    values.push(opts.status);
  }

  values.push(Math.min(opts.limit ?? 50, 200));

  const { rows } = await getPool().query(
    `SELECT * FROM job_queue WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT $${paramIdx}`,
    values,
  );
  return rows.map(rowToJob);
}
