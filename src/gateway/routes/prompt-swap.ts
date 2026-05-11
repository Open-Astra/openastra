import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { setPromptOverride, clearPromptOverride } from "../../agents/prompt-hot-swap.js";

const PromptOverrideBody = z.object({
  systemPrompt: z.string().min(1),
  ttlSeconds: z.number().int().min(1).max(86400).optional(),
});

export function createPromptSwapRouter(): Router {
  const router = Router();

  // POST /agents/:id/prompt-override — set a live prompt override with TTL
  router.post("/:id/prompt-override", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const { id } = req.params as { id: string };

    const parsed = PromptOverrideBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    try {
      setPromptOverride(id, parsed.data.systemPrompt, parsed.data.ttlSeconds);
      res.json({ agentId: id, message: "Prompt override set", ttlSeconds: parsed.data.ttlSeconds ?? 3600 });
    } catch (err) {
      console.error("[prompt-swap] Set override:", err);
      res.status(500).json({ error: "Failed to set prompt override" });
    }
  });

  // DELETE /agents/:id/prompt-override — clear the live prompt override
  router.delete("/:id/prompt-override", (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const { id } = req.params as { id: string };

    try {
      clearPromptOverride(id);
      res.json({ agentId: id, message: "Prompt override cleared" });
    } catch (err) {
      console.error("[prompt-swap] Clear override:", err);
      res.status(500).json({ error: "Failed to clear prompt override" });
    }
  });

  return router;
}
