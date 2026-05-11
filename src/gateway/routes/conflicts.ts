import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import {
  getUnresolvedConflicts,
  getConflict,
  resolveConflict,
  type ResolutionStrategy,
} from "../../agents/conflict-resolution.js";

const ResolveBody = z.object({
  strategy: z.enum(["higher_confidence", "user_escalation", "vote", "most_recent"]),
});

export function createConflictsRouter(): Router {
  const router = Router();

  // GET /conflicts — list unresolved conflicts for workspace
  router.get("/", (req: Request, res: Response) => {
    const workspace = (req as unknown as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const conflicts = getUnresolvedConflicts(workspaceId);
    res.json({ conflicts });
  });

  // GET /conflicts/:id — get conflict details
  router.get("/:id", (req: Request, res: Response) => {
    const conflict = getConflict(req.params.id as string);
    if (!conflict) {
      res.status(404).json({ error: "Conflict not found" });
      return;
    }
    res.json(conflict);
  });

  // POST /conflicts/:id/resolve — manually resolve with strategy
  router.post("/:id/resolve", async (req: Request, res: Response) => {
    const conflict = getConflict(req.params.id as string);
    if (!conflict) {
      res.status(404).json({ error: "Conflict not found" });
      return;
    }

    if (conflict.resolved) {
      res.status(409).json({ error: "Conflict already resolved", conflict });
      return;
    }

    const parsed = ResolveBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    try {
      const resolved = await resolveConflict(conflict, parsed.data.strategy as ResolutionStrategy);
      res.json(resolved);
    } catch (err) {
      console.error("[conflicts] Resolve:", err);
      res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
    }
  });

  return router;
}
