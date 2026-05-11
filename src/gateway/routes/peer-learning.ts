import { Router } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import {
  detectLearningOpportunity,
  getLearningOpportunities,
  markLearningApplied,
} from "../../agents/peer-learning.js";
import { getInferenceClientForAgent } from "../../inference/factory.js";
import { getAgentConfig } from "../../config/agents.js";

const DetectBody = z.object({
  successAgentId: z.string(),
  failedAgentId: z.string(),
  successContent: z.string(),
  failedContent: z.string(),
  taskDescription: z.string(),
});

export function createPeerLearningRouter(): Router {
  const router = Router();

  // GET /peer-learning — list learning opportunities
  router.get("/peer-learning", (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    const agentId = req.query["agentId"] as string | undefined;
    const opportunities = getLearningOpportunities(workspaceId, agentId);
    res.json({ opportunities });
  });

  // POST /peer-learning/detect — trigger detection
  router.post("/peer-learning/detect", async (req, res) => {
    const body = DetectBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: body.error.issues }); return; }
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }

    let client;
    try {
      const agentConfig = getAgentConfig(body.data.successAgentId);
      client = getInferenceClientForAgent(agentConfig);
    } catch {
      res.status(404).json({ error: `Agent ${body.data.successAgentId} not found` });
      return;
    }

    const opportunity = await detectLearningOpportunity(
      workspaceId,
      body.data.successAgentId,
      body.data.failedAgentId,
      body.data.successContent,
      body.data.failedContent,
      body.data.taskDescription,
      client,
    );

    if (!opportunity) {
      res.json({ detected: false, opportunity: null });
      return;
    }
    res.status(201).json({ detected: true, opportunity });
  });

  // POST /peer-learning/:id/apply — mark as applied
  router.post("/peer-learning/:id/apply", (req, res) => {
    const id = req.params["id"];
    if (!id) { res.status(400).json({ error: "ID required" }); return; }
    markLearningApplied(id);
    res.json({ applied: true });
  });

  return router;
}
