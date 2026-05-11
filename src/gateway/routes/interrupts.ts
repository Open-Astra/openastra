import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import {
  requestInterrupt,
  getActiveInterrupts,
  clearInterrupt,
} from "../../agents/interrupts.js";

const CreateInterruptBody = z.object({
  targetAgentId: z.string().min(1),
  reason: z.string().min(1).max(1000),
  priority: z.number().int().min(0).max(100),
});

export function createInterruptsRouter(): Router {
  const router = Router();

  // POST /interrupts — request an interrupt
  router.post("/", (req: Request, res: Response) => {
    const workspace = (req as unknown as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = CreateInterruptBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const uid = (req as unknown as AuthenticatedRequest).uid;
    const { targetAgentId, reason, priority } = parsed.data;

    try {
      const interrupt = requestInterrupt(workspaceId, uid, targetAgentId, reason, priority);
      res.status(201).json(interrupt);
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : "Conflict" });
    }
  });

  // GET /interrupts — list active interrupts in workspace
  router.get("/", (req: Request, res: Response) => {
    const workspace = (req as unknown as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const interrupts = getActiveInterrupts(workspaceId);
    res.json({ interrupts });
  });

  // DELETE /interrupts/:agentId — clear interrupt for an agent
  router.delete("/:agentId", (req: Request, res: Response) => {
    const workspace = (req as unknown as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    clearInterrupt(req.params.agentId as string, workspaceId);
    res.status(204).end();
  });

  return router;
}
