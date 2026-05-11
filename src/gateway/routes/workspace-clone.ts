import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { cloneWorkspace } from "../../workspaces/clone.js";

const CloneBody = z.object({
  name: z.string().min(1).max(255),
  options: z.object({
    includeAgents: z.boolean().optional(),
    includeMemoryProfiles: z.boolean().optional(),
    includeSkills: z.boolean().optional(),
    includeMappings: z.boolean().optional(),
  }).optional(),
});

// ── Workspace Clone Router ────────────────────────────────────────────

export function createWorkspaceCloneRouter(): Router {
  const router = Router();

  // POST /workspaces/:id/clone — clone a workspace
  router.post("/:id/clone", requireRole("owner"), async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    const uid = (req as AuthenticatedRequest).uid;

    if (!workspaceId) {
      res.status(400).json({ error: "Workspace context required" });
      return;
    }

    // Verify the requester's workspace context matches the target workspace
    const { id: sourceId } = req.params as { id: string };
    if (workspaceId !== sourceId) {
      res.status(403).json({ error: "Cannot clone a workspace you do not own" });
      return;
    }

    const parsed = CloneBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    try {
      const result = await cloneWorkspace(
        sourceId,
        parsed.data.name,
        parsed.data.options ?? {},
        uid,
      );

      res.status(201).json(result);
    } catch (err) {
      console.error("[workspace-clone] Clone:", err);
      res.status(500).json({ error: "Failed to clone workspace" });
    }
  });

  return router;
}
