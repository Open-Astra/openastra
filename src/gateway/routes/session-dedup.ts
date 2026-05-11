import { Router } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { findDuplicateSessions, mergeSessions } from "../../memory/session-dedup.js";

const MergeBody = z.object({
  primarySessionId: z.string().uuid(),
  duplicateSessionIds: z.array(z.string().uuid()).min(1),
});

export function createSessionDedupRouter(): Router {
  const router = Router();

  router.get("/sessions/duplicates", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    const threshold = parseFloat(String(req.query["threshold"] ?? "0.90"));
    const groups = await findDuplicateSessions(workspaceId, threshold);
    res.json({ groups, count: groups.length });
  });

  router.post("/sessions/merge", async (req, res) => {
    const body = MergeBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: body.error.issues }); return; }
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    await mergeSessions(body.data.primarySessionId, body.data.duplicateSessionIds, workspaceId);
    res.json({ merged: true, into: body.data.primarySessionId });
  });

  return router;
}
