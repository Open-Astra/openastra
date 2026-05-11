import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";
import { enqueueJob } from "./queue.js";

// ── Dead Letter Queue ────────────────────────────────────────────────
// Stores failed jobs for inspection and replay.
// Failed jobs are written here when they exhaust all retries.
// Operators can replay (re-enqueue) or resolve (dismiss) entries.
//
// API surface:
//   sendToDlq()      — write a failed job (called by worker on final failure)
//   moveToDLQ()      — explicit move by jobId with error + attempts metadata
//   getDLQJobs()     — paginated list of DLQ entries
//   retryDLQJob()    — move a DLQ entry back to the main job queue
//   purgeDLQ()       — delete old resolved/unresolved entries by age
//   listDlqEntries() — workspace-scoped list (used by route)
//   replayDlqEntry() — re-enqueue (used by route)
//   resolveDlqEntry()— dismiss without replay (used by route)

const log = createLogger("dlq");

export interface DlqEntry {
  id: string;
  workspaceId: string | null;
  jobType: string;
  payload: unknown;
  errorMessage: string;
  attempts: number;
  originalJobId: string | null;
  createdAt: Date;
  lastAttemptedAt: Date;
  resolved: boolean;
  resolvedAt: Date | null;
}

interface SendToDlqOptions {
  jobType: string;
  payload: unknown;
  errorMessage: string;
  originalJobId?: string;
  workspaceId?: string;
}

function rowToDlqEntry(row: Record<string, unknown>): DlqEntry {
  return {
    id: row.id as string,
    workspaceId: (row.workspace_id ?? null) as string | null,
    jobType: row.job_type as string,
    payload: row.payload,
    errorMessage: row.error_message as string,
    attempts: row.attempts as number,
    originalJobId: (row.original_job_id ?? null) as string | null,
    createdAt: row.created_at as Date,
    lastAttemptedAt: row.last_attempted_at as Date,
    resolved: row.resolved as boolean,
    resolvedAt: (row.resolved_at ?? null) as Date | null,
  };
}

/**
 * Write a failed job to the dead letter queue.
 */
export async function sendToDlq(options: SendToDlqOptions): Promise<void> {
  const pool = getPool();
  const { jobType, payload, errorMessage, originalJobId, workspaceId } = options;

  try {
    await pool.query(
      `INSERT INTO dead_letter_queue
         (workspace_id, job_type, payload, error_message, original_job_id)
       VALUES ($1, $2, $3::jsonb, $4, $5)`,
      [
        workspaceId ?? null,
        jobType,
        JSON.stringify(payload),
        errorMessage,
        originalJobId ?? null,
      ],
    );
    log.warn(`Job sent to DLQ: type=${jobType} originalId=${originalJobId ?? "n/a"}`);
  } catch (err) {
    log.error("Failed to write to DLQ:", err);
  }
}

/**
 * Move a failed job to the DLQ by job ID, error message, and attempt count.
 * This is the explicit "move" API (vs sendToDlq which is fire-and-forget).
 */
export async function moveToDLQ(
  jobId: string,
  error: string,
  attempts: number,
): Promise<string> {
  const pool = getPool();

  // Look up the original job to capture its type, payload, and workspace
  const { rows: jobRows } = await pool.query(
    `SELECT type, payload, workspace_id, created_at FROM job_queue WHERE id = $1`,
    [jobId],
  );

  let jobType = "unknown";
  let payload: unknown = {};
  let workspaceId: string | null = null;
  let originalCreatedAt: Date | null = null;

  if (jobRows.length > 0) {
    const row = jobRows[0] as Record<string, unknown>;
    jobType = row.type as string;
    payload = row.payload;
    workspaceId = (row.workspace_id ?? null) as string | null;
    originalCreatedAt = (row.created_at ?? null) as Date | null;
  }

  const { rows } = await pool.query(
    `INSERT INTO dead_letter_queue
       (workspace_id, job_type, payload, error_message, attempts, original_job_id, original_created_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
     RETURNING id`,
    [
      workspaceId,
      jobType,
      JSON.stringify(payload),
      error,
      attempts,
      jobId,
      originalCreatedAt,
    ],
  );

  const dlqId = (rows[0] as Record<string, unknown>).id as string;
  log.warn(`Job moved to DLQ: jobId=${jobId} dlqId=${dlqId} type=${jobType} attempts=${attempts}`);
  return dlqId;
}

/**
 * Paginated list of DLQ entries (all workspaces).
 */
export async function getDLQJobs(
  limit = 50,
  offset = 0,
): Promise<{ entries: DlqEntry[]; total: number }> {
  const pool = getPool();
  const safeLimit = Math.min(Math.max(1, limit), 200);
  const safeOffset = Math.max(0, offset);

  const [dataResult, countResult] = await Promise.all([
    pool.query(
      `SELECT * FROM dead_letter_queue
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [safeLimit, safeOffset],
    ),
    pool.query(`SELECT COUNT(*)::int AS total FROM dead_letter_queue`),
  ]);

  const entries = (dataResult.rows as Record<string, unknown>[]).map(rowToDlqEntry);
  const total = (countResult.rows[0] as Record<string, unknown>).total as number;

  return { entries, total };
}

/**
 * Retry a DLQ job by moving it back to the main job queue.
 * Marks the DLQ entry as resolved after successful re-enqueue.
 */
export async function retryDLQJob(dlqId: string): Promise<string> {
  const pool = getPool();

  const { rows } = await pool.query(
    `SELECT * FROM dead_letter_queue WHERE id = $1 AND resolved = false`,
    [dlqId],
  );

  if (rows.length === 0) {
    throw new Error(`DLQ entry not found or already resolved: ${dlqId}`);
  }

  const entry = rowToDlqEntry(rows[0] as Record<string, unknown>);

  // Re-enqueue with fresh retries
  const newJob = await enqueueJob(
    entry.jobType,
    (entry.payload as Record<string, unknown>) ?? {},
    entry.workspaceId ?? "system",
    { maxRetries: 3 },
  );

  // Mark DLQ entry as resolved
  await pool.query(
    `UPDATE dead_letter_queue
     SET resolved = true, resolved_at = NOW(), attempts = attempts + 1, last_attempted_at = NOW()
     WHERE id = $1`,
    [dlqId],
  );

  log.dim(`DLQ entry retried: dlqId=${dlqId} newJobId=${newJob.id} type=${entry.jobType}`);
  return newJob.id;
}

/**
 * Purge old DLQ entries older than the specified number of days.
 * Deletes both resolved and unresolved entries.
 */
export async function purgeDLQ(olderThanDays: number): Promise<number> {
  const pool = getPool();
  const safeDays = Math.max(1, Math.floor(olderThanDays));

  const { rowCount } = await pool.query(
    `DELETE FROM dead_letter_queue
     WHERE created_at < NOW() - INTERVAL '1 day' * $1`,
    [safeDays],
  );

  const deleted = rowCount ?? 0;
  log.dim(`DLQ purged: ${deleted} entries older than ${safeDays} days`);
  return deleted;
}

/**
 * List DLQ entries, optionally filtered by workspace.
 */
export async function listDlqEntries(
  workspaceId?: string,
  limit = 50,
): Promise<DlqEntry[]> {
  const pool = getPool();
  const safeLimit = Math.min(Math.max(1, limit), 200);

  let rows: Record<string, unknown>[];

  if (workspaceId) {
    const result = await pool.query(
      `SELECT * FROM dead_letter_queue
       WHERE workspace_id = $1 AND resolved = false
       ORDER BY created_at DESC
       LIMIT $2`,
      [workspaceId, safeLimit],
    );
    rows = result.rows as Record<string, unknown>[];
  } else {
    const result = await pool.query(
      `SELECT * FROM dead_letter_queue
       WHERE resolved = false
       ORDER BY created_at DESC
       LIMIT $1`,
      [safeLimit],
    );
    rows = result.rows as Record<string, unknown>[];
  }

  return rows.map(rowToDlqEntry);
}

/**
 * Re-enqueue a DLQ entry back into the job queue.
 */
export async function replayDlqEntry(entryId: string): Promise<void> {
  const pool = getPool();

  const { rows } = await pool.query(
    `SELECT * FROM dead_letter_queue WHERE id = $1 AND resolved = false`,
    [entryId],
  );

  if (rows.length === 0) {
    throw new Error(`DLQ entry not found or already resolved: ${entryId}`);
  }

  const entry = rowToDlqEntry(rows[0] as Record<string, unknown>);

  // Re-enqueue in the job queue
  await enqueueJob(
    entry.jobType,
    (entry.payload as Record<string, unknown>) ?? {},
    entry.workspaceId ?? "system",
    { maxRetries: 1 },
  );

  // Update the DLQ entry: increment attempts and update last_attempted_at
  await pool.query(
    `UPDATE dead_letter_queue
     SET attempts = attempts + 1, last_attempted_at = NOW()
     WHERE id = $1`,
    [entryId],
  );

  log.dim(`DLQ entry replayed: id=${entryId} type=${entry.jobType}`);
}

/**
 * Mark a DLQ entry as resolved without re-enqueuing.
 */
export async function resolveDlqEntry(entryId: string): Promise<void> {
  const pool = getPool();

  const { rowCount } = await pool.query(
    `UPDATE dead_letter_queue
     SET resolved = true, resolved_at = NOW()
     WHERE id = $1 AND resolved = false`,
    [entryId],
  );

  if ((rowCount ?? 0) === 0) {
    throw new Error(`DLQ entry not found or already resolved: ${entryId}`);
  }

  log.dim(`DLQ entry resolved: id=${entryId}`);
}
