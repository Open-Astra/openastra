import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { getInferenceClientForAgent } from "../../inference/factory.js";
import { runPipeline } from "../../agents/pipeline.js";

// ── Zod Schemas ──────────────────────────────────────────────────────

const PipelineStageSchema = z.object({
  agentId: z.string().min(1),
  systemPromptSuffix: z.string().max(2000).optional(),
});

const RunPipelineBody = z.object({
  input: z.string().min(1).max(100_000),
  stages: z.array(PipelineStageSchema).min(1).max(20),
});

// ── Router ───────────────────────────────────────────────────────────

export function createPipelinesRouter(): Router {
  const router = Router();

  // POST /pipelines/run — execute a pipeline
  router.post("/run", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;

    const parsed = RunPipelineBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const ctx = {
      uid: (req as AuthenticatedRequest).uid ?? "anonymous",
      workspaceId: workspaceId ?? undefined,
    };

    try {
      const resolveClient = (config: Parameters<typeof getInferenceClientForAgent>[0]) =>
        getInferenceClientForAgent(config);

      const result = await runPipeline(
        parsed.data.input,
        parsed.data.stages,
        resolveClient,
        ctx,
      );

      res.status(200).json({ pipeline: result });
    } catch (err) {
      console.error("[pipelines] Run:", err);
      if (err instanceof Error && err.message.startsWith("Unknown agent:")) {
        res.status(404).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Failed to run pipeline" });
    }
  });

  return router;
}
