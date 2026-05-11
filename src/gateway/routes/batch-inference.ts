import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { runAgentLoop } from "../../agents/loop.js";
import { getAgentConfig } from "../../config/agents.js";
import { getInferenceClientForAgent } from "../../inference/factory.js";

// ── Batch Inference Endpoint ────────────────────────────────────────
// Accepts multiple prompts and processes them concurrently with a
// configurable concurrency limit using a semaphore pattern.

const BatchInferenceBody = z.object({
  agentId: z.string().min(1),
  prompts: z.array(z.string().min(1).max(10000)).min(1).max(50),
  maxConcurrency: z.number().int().min(1).max(20).optional().default(5),
});

interface BatchResult {
  content: string;
  usage: {
    prompt: number;
    completion: number;
    total: number;
  };
}

interface BatchError {
  error: string;
}

/**
 * Simple semaphore for limiting concurrency.
 */
class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

export function createBatchInferenceRouter(): Router {
  const router = Router();

  // POST /batch-inference
  router.post("/", async (req: Request, res: Response) => {
    const uid = (req as unknown as AuthenticatedRequest).uid;
    const workspace = (req as unknown as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId ?? undefined;

    const parsed = BatchInferenceBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const { agentId, prompts, maxConcurrency } = parsed.data;

    let agentConfig;
    try {
      agentConfig = getAgentConfig(agentId);
    } catch {
      res.status(404).json({ error: `Agent not found: ${agentId}` });
      return;
    }

    const client = getInferenceClientForAgent(agentConfig);
    const semaphore = new Semaphore(maxConcurrency);

    const promises = prompts.map(async (prompt): Promise<BatchResult | BatchError> => {
      await semaphore.acquire();
      try {
        const result = await runAgentLoop(
          uid,
          prompt,
          agentConfig,
          client,
          undefined,
          workspaceId,
        );
        return {
          content: result.content,
          usage: {
            prompt: result.tokenUsage.prompt,
            completion: result.tokenUsage.completion,
            total: result.tokenUsage.total,
          },
        };
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        semaphore.release();
      }
    });

    try {
      const settled = await Promise.allSettled(promises);
      const results = settled.map((s) => {
        if (s.status === "fulfilled") return s.value;
        return { error: s.reason instanceof Error ? s.reason.message : String(s.reason) };
      });

      res.json({ results });
    } catch (err) {
      console.error("[batch-inference] Error:", err);
      res.status(500).json({ error: "Batch inference failed" });
    }
  });

  return router;
}
