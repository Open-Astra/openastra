import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { getEventBus } from "../events/index.js";
import { createLogger } from "../utils/logger.js";
import type { WorkflowDefinition, WorkflowStep, ResolveClientFn } from "./engine.js";

const logger = createLogger("durable-execution");

// ── Durable Execution Engine ──────────────────────────────────────────
// Extends the workflow engine with:
//   - Checkpoint persistence (survives process restarts)
//   - Automatic retries with exponential backoff
//   - Step-level timeouts
//   - Dead-letter queue for permanently failed runs
//   - Heartbeat-based liveness detection
//   - Resumable execution from last successful checkpoint

// ── Types ────────────────────────────────────────────────────────────

export type RunStatus =
  | "pending"
  | "running"
  | "paused"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "dead_letter";

export interface DurableRunConfig {
  maxRetries: number;
  retryBackoffMs: number;
  stepTimeoutMs: number;
  globalTimeoutMs: number;
  heartbeatIntervalMs: number;
  deadLetterAfterRetries: number;
}

export interface Checkpoint {
  runId: string;
  stepIndex: number;
  stepId: string;
  vars: Record<string, unknown>;
  status: RunStatus;
  attempts: number;
  lastError?: string;
  createdAt: string;
}

export interface DurableRun {
  id: string;
  workflowId: string;
  workspaceId: string;
  tenantId: string;
  uid: string;
  status: RunStatus;
  input: Record<string, unknown>;
  config: DurableRunConfig;
  currentStepIndex: number;
  attempts: number;
  lastHeartbeat: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
}

export interface DurableRunResult {
  runId: string;
  status: RunStatus;
  vars: Record<string, unknown>;
  stepCount: number;
  durationMs: number;
  retries: number;
  error?: string;
}

export interface DeadLetterEntry {
  id: string;
  runId: string;
  workflowId: string;
  tenantId: string;
  stepId: string;
  error: string;
  attempts: number;
  input: Record<string, unknown>;
  lastCheckpoint: Checkpoint;
  createdAt: string;
}

const DEFAULT_CONFIG: DurableRunConfig = {
  maxRetries: 3,
  retryBackoffMs: 2000,
  stepTimeoutMs: 60_000,
  globalTimeoutMs: 600_000,
  heartbeatIntervalMs: 10_000,
  deadLetterAfterRetries: 5,
};

// ── Durable Execution Manager ─────────────────────────────────────────

export class DurableExecutionManager {
  private activeRuns = new Map<string, AbortController>();
  private heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();

  async createRun(params: {
    workflowId: string;
    workspaceId: string;
    tenantId: string;
    uid: string;
    input: Record<string, unknown>;
    config?: Partial<DurableRunConfig>;
  }): Promise<DurableRun> {
    const pool = getPool();
    const id = randomUUID();
    const config = { ...DEFAULT_CONFIG, ...params.config };

    const run: DurableRun = {
      id,
      workflowId: params.workflowId,
      workspaceId: params.workspaceId,
      tenantId: params.tenantId,
      uid: params.uid,
      status: "pending",
      input: params.input,
      config,
      currentStepIndex: 0,
      attempts: 0,
      lastHeartbeat: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await pool.query(
      `INSERT INTO durable_runs (id, workflow_id, workspace_id, tenant_id, uid, status, input, config, current_step_index, attempts, last_heartbeat)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
      [id, params.workflowId, params.workspaceId, params.tenantId, params.uid, "pending", JSON.stringify(params.input), JSON.stringify(config), 0, 0],
    );

    getEventBus().emit("workflow.created", { runId: id, workflowId: params.workflowId, tenantId: params.tenantId });
    logger.info(`Created durable run ${id} for workflow ${params.workflowId}`);
    return run;
  }

  async executeRun(
    run: DurableRun,
    definition: WorkflowDefinition,
    resolveClient: ResolveClientFn,
  ): Promise<DurableRunResult> {
    const pool = getPool();
    const startTime = Date.now();
    const bus = getEventBus();
    const controller = new AbortController();
    this.activeRuns.set(run.id, controller);

    // Start heartbeat
    this.startHeartbeat(run.id);

    // Update status to running
    await this.updateRunStatus(run.id, "running");
    bus.emit("workflow.started", { runId: run.id, workflowId: run.workflowId, tenantId: run.tenantId });

    const vars: Record<string, unknown> = { ...run.input };
    let stepIndex = run.currentStepIndex;
    let totalRetries = 0;

    // Resume from last checkpoint if available
    const checkpoint = await this.getLatestCheckpoint(run.id);
    if (checkpoint) {
      stepIndex = checkpoint.stepIndex;
      Object.assign(vars, checkpoint.vars);
      logger.info(`Resuming run ${run.id} from step ${stepIndex}`);
    }

    try {
      const steps = definition.steps;

      while (stepIndex < steps.length) {
        if (controller.signal.aborted) {
          throw new Error("Run aborted");
        }

        // Check global timeout
        if (Date.now() - startTime > run.config.globalTimeoutMs) {
          throw new Error(`Global timeout exceeded (${run.config.globalTimeoutMs}ms)`);
        }

        const step = steps[stepIndex]!;
        let stepSuccess = false;
        let stepAttempts = 0;

        while (!stepSuccess && stepAttempts <= run.config.maxRetries) {
          try {
            await this.executeStepWithTimeout(step, vars, resolveClient, run.config.stepTimeoutMs);
            stepSuccess = true;

            // Checkpoint after successful step
            await this.saveCheckpoint({
              runId: run.id,
              stepIndex: stepIndex + 1,
              stepId: step.id,
              vars: { ...vars },
              status: "running",
              attempts: stepAttempts,
              createdAt: new Date().toISOString(),
            });
          } catch (err) {
            stepAttempts++;
            totalRetries++;
            const error = err instanceof Error ? err.message : String(err);

            logger.warn(`Step ${step.id} attempt ${stepAttempts} failed: ${error}`);
            bus.emit("workflow.step_failed", {
              runId: run.id,
              stepId: step.id,
              attempt: stepAttempts,
              error,
            });

            if (stepAttempts > run.config.maxRetries) {
              // Check if we should dead-letter
              if (run.attempts + 1 >= run.config.deadLetterAfterRetries) {
                await this.sendToDeadLetter(run, step, error, vars);
                return {
                  runId: run.id,
                  status: "dead_letter",
                  vars,
                  stepCount: stepIndex,
                  durationMs: Date.now() - startTime,
                  retries: totalRetries,
                  error: `Dead-lettered after ${run.config.deadLetterAfterRetries} total attempts: ${error}`,
                };
              }
              throw new Error(`Step ${step.id} failed after ${stepAttempts} attempts: ${error}`);
            }

            // Exponential backoff
            const delay = run.config.retryBackoffMs * Math.pow(2, stepAttempts - 1);
            await sleep(delay);
          }
        }

        stepIndex++;
        await pool.query(
          `UPDATE durable_runs SET current_step_index = $1, updated_at = NOW() WHERE id = $2`,
          [stepIndex, run.id],
        );
      }

      // Completed successfully
      await this.updateRunStatus(run.id, "completed");
      bus.emit("workflow.completed", {
        runId: run.id,
        workflowId: run.workflowId,
        tenantId: run.tenantId,
        durationMs: Date.now() - startTime,
      });

      return {
        runId: run.id,
        status: "completed",
        vars,
        stepCount: stepIndex,
        durationMs: Date.now() - startTime,
        retries: totalRetries,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await this.updateRunStatus(run.id, "failed", error);
      bus.emit("workflow.failed", { runId: run.id, workflowId: run.workflowId, error });

      return {
        runId: run.id,
        status: "failed",
        vars,
        stepCount: stepIndex,
        durationMs: Date.now() - startTime,
        retries: totalRetries,
        error,
      };
    } finally {
      this.stopHeartbeat(run.id);
      this.activeRuns.delete(run.id);
    }
  }

  async pauseRun(runId: string): Promise<void> {
    const controller = this.activeRuns.get(runId);
    if (controller) {
      controller.abort();
    }
    await this.updateRunStatus(runId, "paused");
    getEventBus().emit("workflow.paused", { runId });
    logger.info(`Paused run ${runId}`);
  }

  async resumeRun(
    runId: string,
    definition: WorkflowDefinition,
    resolveClient: ResolveClientFn,
  ): Promise<DurableRunResult> {
    const run = await this.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (run.status !== "paused" && run.status !== "waiting_approval") {
      throw new Error(`Cannot resume run in status: ${run.status}`);
    }
    return this.executeRun(run, definition, resolveClient);
  }

  async cancelRun(runId: string): Promise<void> {
    const controller = this.activeRuns.get(runId);
    if (controller) controller.abort();
    await this.updateRunStatus(runId, "failed", "Cancelled by user");
    this.stopHeartbeat(runId);
    this.activeRuns.delete(runId);
    logger.info(`Cancelled run ${runId}`);
  }

  // ── Dead Letter Queue ─────────────────────────────────────────────

  async getDeadLetterQueue(tenantId: string, limit = 50): Promise<DeadLetterEntry[]> {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT * FROM dead_letter_queue WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [tenantId, limit],
    );
    return rows as DeadLetterEntry[];
  }

  async retryDeadLetter(
    entryId: string,
    definition: WorkflowDefinition,
    resolveClient: ResolveClientFn,
  ): Promise<DurableRunResult> {
    const pool = getPool();
    const { rows } = await pool.query(`SELECT * FROM dead_letter_queue WHERE id = $1`, [entryId]);
    if (rows.length === 0) throw new Error(`Dead letter entry not found: ${entryId}`);

    const entry = rows[0] as DeadLetterEntry;
    const run = await this.getRun(entry.runId);
    if (!run) throw new Error(`Run not found: ${entry.runId}`);

    // Reset run for retry
    await pool.query(
      `UPDATE durable_runs SET status = 'pending', attempts = attempts + 1, error = NULL, updated_at = NOW() WHERE id = $1`,
      [run.id],
    );
    await pool.query(`DELETE FROM dead_letter_queue WHERE id = $1`, [entryId]);

    run.status = "pending";
    return this.executeRun(run, definition, resolveClient);
  }

  async purgeDeadLetter(tenantId: string, olderThanDays = 30): Promise<number> {
    const pool = getPool();
    const { rowCount } = await pool.query(
      `DELETE FROM dead_letter_queue WHERE tenant_id = $1 AND created_at < NOW() - INTERVAL '1 day' * $2`,
      [tenantId, olderThanDays],
    );
    return rowCount ?? 0;
  }

  // ── Stale Run Recovery ────────────────────────────────────────────

  async recoverStaleRuns(staleSinceMs = 60_000): Promise<string[]> {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT id FROM durable_runs
       WHERE status = 'running' AND last_heartbeat < NOW() - INTERVAL '1 ms' * $1`,
      [staleSinceMs],
    );

    const recovered: string[] = [];
    for (const row of rows as { id: string }[]) {
      await this.updateRunStatus(row.id, "paused", "Recovered from stale state (no heartbeat)");
      recovered.push(row.id);
      logger.warn(`Recovered stale run ${row.id}`);
    }
    return recovered;
  }

  // ── Queries ───────────────────────────────────────────────────────

  async getRun(runId: string): Promise<DurableRun | null> {
    const pool = getPool();
    const { rows } = await pool.query(`SELECT * FROM durable_runs WHERE id = $1`, [runId]);
    if (rows.length === 0) return null;
    return this.rowToRun(rows[0]);
  }

  async listRuns(tenantId: string, filters?: { status?: RunStatus; limit?: number }): Promise<DurableRun[]> {
    const pool = getPool();
    let query = `SELECT * FROM durable_runs WHERE tenant_id = $1`;
    const params: unknown[] = [tenantId];

    if (filters?.status) {
      params.push(filters.status);
      query += ` AND status = $${params.length}`;
    }
    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(filters?.limit ?? 100);

    const { rows } = await pool.query(query, params);
    return rows.map((r: Record<string, unknown>) => this.rowToRun(r));
  }

  // ── Internal ──────────────────────────────────────────────────────

  private async executeStepWithTimeout(
    step: WorkflowStep,
    vars: Record<string, unknown>,
    resolveClient: ResolveClientFn,
    timeoutMs: number,
  ): Promise<void> {
    const { executeWorkflow } = await import("./engine.js");
    const singleStepDef: WorkflowDefinition = { steps: [step] };

    const result = await Promise.race([
      executeWorkflow(
        { id: randomUUID(), workflowId: "step", workspaceId: "internal", uid: "system", input: vars },
        singleStepDef,
        resolveClient,
      ),
      sleep(timeoutMs).then(() => {
        throw new Error(`Step timeout after ${timeoutMs}ms`);
      }),
    ]);

    if (result && typeof result === "object" && "vars" in result) {
      Object.assign(vars, result.vars);
    }
  }

  private async saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
    const pool = getPool();
    await pool.query(
      `INSERT INTO workflow_checkpoints (run_id, step_index, step_id, vars, status, attempts)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [checkpoint.runId, checkpoint.stepIndex, checkpoint.stepId, JSON.stringify(checkpoint.vars), checkpoint.status, checkpoint.attempts],
    );
  }

  private async getLatestCheckpoint(runId: string): Promise<Checkpoint | null> {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT * FROM workflow_checkpoints WHERE run_id = $1 ORDER BY step_index DESC LIMIT 1`,
      [runId],
    );
    if (rows.length === 0) return null;
    const row = rows[0] as Record<string, unknown>;
    return {
      runId: row.run_id as string,
      stepIndex: row.step_index as number,
      stepId: row.step_id as string,
      vars: typeof row.vars === "string" ? JSON.parse(row.vars) : row.vars as Record<string, unknown>,
      status: row.status as RunStatus,
      attempts: row.attempts as number,
      createdAt: String(row.created_at),
    };
  }

  private async sendToDeadLetter(
    run: DurableRun,
    step: WorkflowStep,
    error: string,
    vars: Record<string, unknown>,
  ): Promise<void> {
    const pool = getPool();
    const id = randomUUID();
    const checkpoint = await this.getLatestCheckpoint(run.id);

    await pool.query(
      `INSERT INTO dead_letter_queue (id, run_id, workflow_id, tenant_id, step_id, error, attempts, input, last_checkpoint)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, run.id, run.workflowId, run.tenantId, step.id, error, run.attempts, JSON.stringify(run.input), JSON.stringify(checkpoint ?? { vars })],
    );

    await this.updateRunStatus(run.id, "dead_letter", error);
    getEventBus().emit("workflow.dead_lettered", { runId: run.id, stepId: step.id, error });
    logger.error(`Run ${run.id} sent to dead letter queue: ${error}`);
  }

  private async updateRunStatus(runId: string, status: RunStatus, error?: string): Promise<void> {
    const pool = getPool();
    const completedAt = status === "completed" || status === "failed" || status === "dead_letter" ? "NOW()" : "NULL";
    await pool.query(
      `UPDATE durable_runs SET status = $1, error = $2, updated_at = NOW(), completed_at = ${completedAt} WHERE id = $3`,
      [status, error ?? null, runId],
    );
  }

  private startHeartbeat(runId: string): void {
    const timer = setInterval(async () => {
      try {
        const pool = getPool();
        await pool.query(`UPDATE durable_runs SET last_heartbeat = NOW() WHERE id = $1`, [runId]);
      } catch {
        logger.warn(`Heartbeat failed for run ${runId}`);
      }
    }, DEFAULT_CONFIG.heartbeatIntervalMs);
    this.heartbeatTimers.set(runId, timer);
  }

  private stopHeartbeat(runId: string): void {
    const timer = this.heartbeatTimers.get(runId);
    if (timer) {
      clearInterval(timer);
      this.heartbeatTimers.delete(runId);
    }
  }

  private rowToRun(row: Record<string, unknown>): DurableRun {
    return {
      id: row.id as string,
      workflowId: row.workflow_id as string,
      workspaceId: row.workspace_id as string,
      tenantId: row.tenant_id as string,
      uid: row.uid as string,
      status: row.status as RunStatus,
      input: typeof row.input === "string" ? JSON.parse(row.input) : row.input as Record<string, unknown>,
      config: typeof row.config === "string" ? JSON.parse(row.config) : row.config as DurableRunConfig,
      currentStepIndex: row.current_step_index as number,
      attempts: row.attempts as number,
      lastHeartbeat: String(row.last_heartbeat),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      completedAt: row.completed_at ? String(row.completed_at) : undefined,
      error: row.error as string | undefined,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Singleton ───────────────────────────────────────────────────────

let instance: DurableExecutionManager | null = null;

export function getDurableExecutionManager(): DurableExecutionManager {
  if (!instance) instance = new DurableExecutionManager();
  return instance;
}
