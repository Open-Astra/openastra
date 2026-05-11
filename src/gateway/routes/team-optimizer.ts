import { Router } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import {
  analyzeTeamPerformance,
  recommendTeam,
  getRecommendationHistory,
  getRecommendation,
} from "../../agents/team-optimizer.js";

const AnalyzeBody = z.object({
  teamId: z.string().optional(),
});

const RecommendBody = z.object({
  taskType: z.string().min(1),
  constraints: z
    .object({
      maxSize: z.number().int().positive().optional(),
      requiredSkills: z.array(z.string()).optional(),
      maxBudget: z.number().positive().optional(),
    })
    .optional(),
});

export function createTeamOptimizerRouter(): Router {
  const router = Router();

  router.post("/team-optimizer/analyze", async (req, res) => {
    const body = AnalyzeBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: body.error.issues }); return; }
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    try {
      const analysis = await analyzeTeamPerformance(workspaceId, body.data.teamId);
      res.json(analysis);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post("/team-optimizer/recommend", async (req, res) => {
    const body = RecommendBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: body.error.issues }); return; }
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    try {
      const rec = await recommendTeam(workspaceId, body.data.taskType, body.data.constraints);
      res.status(201).json(rec);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.get("/team-optimizer/history", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    try {
      const history = await getRecommendationHistory(workspaceId);
      res.json({ recommendations: history });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.get("/team-optimizer/history/:id", async (req, res) => {
    const { id } = req.params as { id: string };
    try {
      const rec = await getRecommendation(id);
      if (!rec) { res.status(404).json({ error: "Recommendation not found" }); return; }
      res.json(rec);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
