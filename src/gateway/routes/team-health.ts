import { Router } from "express";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { computeTeamHealth, getHealthHistory } from "../../agents/team-health.js";

export function createTeamHealthRouter(): Router {
  const router = Router();

  router.get("/team-health", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    const teamId = req.query["teamId"] ? String(req.query["teamId"]) : undefined;
    const window = (req.query["window"] as "hour" | "day" | "week") ?? "day";
    const health = await computeTeamHealth(workspaceId, teamId, window);
    res.json(health);
  });

  router.get("/team-health/history", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    const teamId = req.query["teamId"] ? String(req.query["teamId"]) : undefined;
    const history = await getHealthHistory(workspaceId, teamId);
    res.json({ snapshots: history });
  });

  router.get("/team-health/trends", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    const teamId = req.query["teamId"] ? String(req.query["teamId"]) : undefined;
    const history = await getHealthHistory(workspaceId, teamId);
    if (history.length < 2) return res.json({ trend: "insufficient_data", snapshots: history.length });
    const recent = history[0]!;
    const older = history[history.length - 1]!;
    const latencyTrend = recent.latency.p50 < older.latency.p50 ? "improving" : "degrading";
    const errorTrend = recent.errorRate < older.errorRate ? "improving" : "degrading";
    const throughputTrend = recent.taskThroughput > older.taskThroughput ? "improving" : "degrading";
    res.json({ latencyTrend, errorTrend, throughputTrend, snapshots: history.length });
  });

  return router;
}
