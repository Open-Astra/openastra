import { Router } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { pinDailyMemory, unpinDailyMemory, getPinnedMemories } from "../../memory/pinning.js";

const PinBody = z.object({
  userId: z.string().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export function createMemoryPinRouter(): Router {
  const router = Router();

  // GET /memory/pinned — list all pinned memories
  router.get("/memory/pinned", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    const uid = (req as unknown as AuthenticatedRequest).uid;
    const userId = (req.query["userId"] as string) ?? uid;
    const pinned = await getPinnedMemories(userId, workspaceId);
    res.json({ pinned });
  });

  // POST /memory/daily/pin — pin a daily memory entry
  router.post("/memory/daily/pin", async (req, res) => {
    const body = PinBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: body.error.issues }); return; }
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    const uid = (req as unknown as AuthenticatedRequest).uid;
    const userId = body.data.userId ?? uid;
    try {
      await pinDailyMemory(userId, body.data.date, workspaceId);
      res.json({ pinned: true });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // DELETE /memory/daily/pin — unpin a daily memory entry
  router.delete("/memory/daily/pin", async (req, res) => {
    const body = PinBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: body.error.issues }); return; }
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    const uid = (req as unknown as AuthenticatedRequest).uid;
    const userId = body.data.userId ?? uid;
    await unpinDailyMemory(userId, body.data.date, workspaceId);
    res.json({ unpinned: true });
  });

  return router;
}
