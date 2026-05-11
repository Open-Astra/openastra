import { randomUUID } from "node:crypto";
import { createLogger } from "../utils/logger.js";
import { getEventBus } from "../events/index.js";
import type { Job } from "./queue.js";
import { claimNextJob, completeJob, failJob, updateJobProgress } from "./queue.js";

const log = createLogger("job-worker");

export type JobHandler = (
  job: Job,
  reportProgress: (pct: number) => Promise<void>,
) => Promise<Record<string, unknown>>;

export class JobWorker {
  private readonly workerId: string;
  private handlers = new Map<string, JobHandler>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private currentJob: Promise<void> | null = null;

  constructor(workerId?: string) {
    this.workerId = workerId ?? `worker-${randomUUID().slice(0, 8)}`;
  }

  register(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
    log.dim(`Registered handler for type "${type}"`);
  }

  start(pollIntervalMs = 2000): void {
    if (this.running) return;
    this.running = true;
    log.active("Job worker started", `worker=${this.workerId}`);
    this.timer = setInterval(() => {
      if (this.currentJob === null) {
        this.currentJob = this.poll().finally(() => {
          this.currentJob = null;
        });
      }
    }, pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.currentJob) {
      await this.currentJob;
    }
    log.warn(`Job worker ${this.workerId} stopped`);
  }

  private async poll(): Promise<void> {
    let job: Job | null = null;
    try {
      job = await claimNextJob(this.workerId);
    } catch (err) {
      log.error("Failed to claim job:", err);
      return;
    }
    if (!job) return;

    const handler = this.handlers.get(job.type);
    if (!handler) {
      log.warn(`No handler for type "${job.type}" — failing job ${job.id}`);
      await failJob(job.id, `No handler registered for type "${job.type}"`, false);
      return;
    }

    const startedAt = Date.now();
    const bus = getEventBus();
    bus.emit("job.started", {
      jobId: job.id,
      workspaceId: job.workspaceId,
      type: job.type,
      workerId: this.workerId,
      timestamp: startedAt,
    });

    const reportProgress = async (pct: number): Promise<void> => {
      await updateJobProgress(job!.id, pct);
    };

    try {
      const result = await Promise.race([
        handler(job, reportProgress),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Job timed out after ${job!.timeoutSeconds}s`)),
            job!.timeoutSeconds * 1000,
          ),
        ),
      ]);
      await completeJob(job.id, result);
      bus.emit("job.completed", {
        jobId: job.id,
        workspaceId: job.workspaceId,
        type: job.type,
        durationMs: Date.now() - startedAt,
        timestamp: Date.now(),
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const willRetry = job.retryCount < job.maxRetries;
      await failJob(job.id, errorMsg, willRetry).catch((e: unknown) =>
        log.error(`Failed to record failure for ${job!.id}:`, e),
      );
      bus.emit("job.failed", {
        jobId: job.id,
        workspaceId: job.workspaceId,
        type: job.type,
        error: errorMsg,
        retryCount: job.retryCount,
        willRetry,
        timestamp: Date.now(),
      });
      // Send to DLQ when all retries are exhausted
      if (!willRetry) {
        const { sendToDlq } = await import("./dlq.js");
        await sendToDlq({
          jobType: job.type,
          payload: job.payload,
          errorMessage: errorMsg,
          originalJobId: job.id,
          workspaceId: job.workspaceId,
        }).catch((e: unknown) => log.error(`Failed to write DLQ for ${job!.id}:`, e));
      }
    }
  }
}
