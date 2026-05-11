import { z } from "zod";
import type { JobWorker } from "../worker.js";
import { getAgentConfig } from "../../config/agents.js";
import { getInferenceClientForAgent } from "../../inference/factory.js";
import { runAgentLoop } from "../../agents/loop.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("job-handler:agent-run");

// ── Payload Schema ──────────────────────────────────────────────────

const AgentRunPayload = z.object({
  agentId: z.string(),
  uid: z.string(),
  message: z.string(),
  sessionId: z.string().optional(),
  workspaceId: z.string().optional(),
});

// ── Handler Registration ────────────────────────────────────────────

export function registerAgentRunHandler(worker: JobWorker): void {
  worker.register("agent_run", async (job, _reportProgress) => {
    const parsed = AgentRunPayload.safeParse(job.payload);
    if (!parsed.success) {
      throw new Error(`Invalid agent_run payload: ${JSON.stringify(parsed.error.format())}`);
    }

    const { agentId, uid, message, sessionId, workspaceId } = parsed.data;

    log.dim(`Running agent_run job ${job.id}: agentId=${agentId} uid=${uid}`);

    const agentConfig = getAgentConfig(agentId);
    const inferenceClient = getInferenceClientForAgent(agentConfig);

    const sessionKey = sessionId
      ? { uid, surface: "chat" as const, surfaceId: sessionId }
      : { uid, surface: "chat" as const, surfaceId: "job" };

    const response = await runAgentLoop(
      uid,
      message,
      agentConfig,
      inferenceClient,
      sessionKey,
      workspaceId,
    );

    return {
      reply: response.content,
      agentId,
      uid,
      sessionId: response.sessionId,
      tokenUsage: response.tokenUsage,
    };
  });
}
