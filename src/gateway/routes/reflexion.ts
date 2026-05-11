// ── Route: Reflexion Logs ───────────────────────────────────────────────
import { Router } from "express";
import { listReflexionLogs } from "../../agents/reflexion.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";

export function createReflexionRouter(): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
    if (!workspaceId) return res.status(400).json({ error: "workspace required" });
    const sessionId = typeof req.query["sessionId"] === "string" ? req.query["sessionId"] : undefined;
    const limit = req.query["limit"] ? parseInt(String(req.query["limit"]), 10) : 50;
    const logs = await listReflexionLogs(workspaceId, sessionId, limit);
    res.json(logs);
  });

  return router;
}
