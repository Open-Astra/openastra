import { Router } from "express";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { estimateCapacity, getCapacityHistory } from "../../agents/capacity-planning.js";

export function createCapacityPlanRouter(): Router {
  const router = Router();

  router.post("/capacity/estimate", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    const { teamId, horizon } = req.body ?? {};
    const estimate = await estimateCapacity(workspaceId, { teamId, horizon });
    res.status(201).json(estimate);
  });

  router.get("/capacity/history", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    const history = await getCapacityHistory(workspaceId);
    res.json({ estimates: history });
  });

  router.get("/capacity/recommendations", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    const estimate = await estimateCapacity(workspaceId);
    res.json({
      recommendedTeamSize: estimate.recommendedTeamSize,
      bottlenecks: estimate.bottlenecks,
      throughput: estimate.teamThroughput,
    });
  });

  return router;
}
