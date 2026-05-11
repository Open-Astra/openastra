import { Router } from "express";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { getSessionTimeline, formatTimelineAsText } from "../../observability/tool-timeline.js";

export function createToolTimelineRouter(): Router {
  const router = Router();

  router.get("/sessions/:sessionId/timeline", async (req, res) => {
    const { sessionId } = req.params as { sessionId: string };
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    const timeline = await getSessionTimeline(sessionId, workspaceId);
    res.json(timeline);
  });

  router.get("/sessions/:sessionId/timeline/text", async (req, res) => {
    const { sessionId } = req.params as { sessionId: string };
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    const timeline = await getSessionTimeline(sessionId, workspaceId);
    res.setHeader("Content-Type", "text/plain");
    res.send(formatTimelineAsText(timeline));
  });

  return router;
}
