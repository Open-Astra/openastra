export {
  enqueueJob,
  claimNextJob,
  updateJobProgress,
  completeJob,
  failJob,
  cancelJob,
  getJob,
  listJobs,
} from "./queue.js";
export type { Job, JobStatus, EnqueueOptions, ListJobsOptions } from "./queue.js";
export { JobWorker } from "./worker.js";
export type { JobHandler } from "./worker.js";

import { JobWorker } from "./worker.js";
import { createLogger } from "../utils/logger.js";
import { registerAgentRunHandler } from "./handlers/index.js";

const log = createLogger("jobs");
let _worker: JobWorker | undefined;

export { registerAgentRunHandler };

export function getJobWorker(): JobWorker {
  if (!_worker) _worker = new JobWorker();
  return _worker;
}

export function startJobWorker(pollIntervalMs = 2000): void {
  if (!_worker) {
    _worker = new JobWorker();
    registerAgentRunHandler(_worker);
  }
  _worker.start(pollIntervalMs);
  log.active("Job worker started");
}

export async function stopJobWorker(): Promise<void> {
  if (_worker) {
    await _worker.stop();
    _worker = undefined;
  }
}
