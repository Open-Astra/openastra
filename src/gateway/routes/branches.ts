import { Router } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { branchSession, listBranches, getBranch } from "../../agents/conversation-branch.js";

const CreateBranchBody = z.object({
  fromMessageIndex: z.number().int().min(0),
  label: z.string().max(200).optional(),
});

export function createBranchesRouter(): Router {
  const router = Router();

  // POST /sessions/:sessionId/branches — fork a session at a message index
  router.post("/sessions/:sessionId/branches", async (req, res) => {
    const body = CreateBranchBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.issues });
      return;
    }
    const { sessionId } = req.params as { sessionId: string };
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    const uid = (req as unknown as AuthenticatedRequest).uid;

    try {
      const result = await branchSession(sessionId, body.data.fromMessageIndex, workspaceId, {
        label: body.data.label,
        createdBy: uid,
      });
      res.status(201).json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(msg.includes("not found") ? 404 : 500).json({ error: msg });
    }
  });

  // GET /sessions/:sessionId/branches — list branches of a session
  router.get("/sessions/:sessionId/branches", async (req, res) => {
    const { sessionId } = req.params as { sessionId: string };
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    const branches = await listBranches(sessionId, workspaceId);
    res.json({ branches });
  });

  // GET /branches/:branchId — get branch details
  router.get("/branches/:branchId", async (req, res) => {
    const { branchId } = req.params as { branchId: string };
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    const branch = await getBranch(branchId, workspaceId);
    if (!branch) { res.status(404).json({ error: "Branch not found" }); return; }
    res.json(branch);
  });

  return router;
}
