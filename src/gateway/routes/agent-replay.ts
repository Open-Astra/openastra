import { Router } from "express";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { buildReplay, getReplayStep } from "../../observability/agent-replay.js";

export function createAgentReplayRouter(): Router {
  const router = Router();

  router.get("/sessions/:sessionId/replay", async (req, res) => {
    const { sessionId } = req.params as { sessionId: string };
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    try {
      const replay = await buildReplay(sessionId, workspaceId);
      res.json(replay);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(msg.includes("not found") ? 404 : 500).json({ error: msg });
    }
  });

  router.get("/sessions/:sessionId/replay/:stepIndex", async (req, res) => {
    const { sessionId, stepIndex } = req.params as { sessionId: string; stepIndex: string };
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    try {
      const step = await getReplayStep(sessionId, parseInt(stepIndex, 10), workspaceId);
      if (!step) { res.status(404).json({ error: "Step not found" }); return; }
      res.json(step);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
