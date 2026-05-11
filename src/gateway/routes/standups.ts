import { Router } from "express";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { generateStandup, getStandups, getStandup } from "../../agents/standup.js";

export function createStandupsRouter(): Router {
  const router = Router();

  router.post("/standups/generate", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    const { teamId, agentIds, since } = req.body ?? {};
    const report = await generateStandup(workspaceId, teamId, agentIds, since ? new Date(since) : undefined);
    res.status(201).json(report);
  });

  router.get("/standups", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    res.json({ standups: getStandups(workspaceId) });
  });

  router.get("/standups/:id", async (req, res) => {
    const report = getStandup(req.params.id);
    if (!report) return res.status(404).json({ error: "Standup not found" });
    res.json(report);
  });

  return router;
}
