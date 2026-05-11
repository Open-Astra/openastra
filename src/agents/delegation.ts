import { enqueueJob } from "../jobs/queue.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("delegation");

export interface DelegationResult {
  taskId: string;
  estimatedCompletionMs?: number;
}

export async function delegateTask(
  message: string,
  agentId: string,
  workspaceId: string,
  uid: string,
  options?: { callbackUrl?: string; delegatedBy?: string },
): Promise<DelegationResult> {
  const job = await enqueueJob(
    "agent_run",
    {
      message,
      agentId,
      uid,
      callbackUrl: options?.callbackUrl,
      delegatedBy: options?.delegatedBy,
    },
    workspaceId,
    { maxRetries: 2, timeoutSeconds: 300 },
  );
  log.info(`Delegated task job=${job.id} agentId=${agentId} delegatedBy=${options?.delegatedBy ?? "unknown"}`);
  return { taskId: job.id, estimatedCompletionMs: 5 * 60 * 1000 };
}
