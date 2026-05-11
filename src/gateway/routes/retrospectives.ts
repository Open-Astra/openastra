import { Router } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import {
  runRetrospective,
  getRetrospectives,
  getRetrospective,
} from "../../agents/retrospective.js";
import { getInferenceClientForAgent } from "../../inference/factory.js";
import { getAgentConfig, getAllAgentConfigs } from "../../config/agents.js";

const RunBody = z.object({
  taskDescription: z.string().min(1),
  agentResults: z.array(
    z.object({
      agentId: z.string(),
      result: z.string(),
      success: z.boolean(),
    }),
  ).min(1),
});

export function createRetrospectivesRouter(): Router {
  const router = Router();

  // GET /retrospectives — list retrospectives
  router.get("/retrospectives", (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    const limitStr = req.query["limit"] as string | undefined;
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;
    const retros = getRetrospectives(workspaceId, limit);
    res.json({ retrospectives: retros });
  });

  // GET /retrospectives/:id — get retrospective detail
  router.get("/retrospectives/:id", (req, res) => {
    const id = req.params["id"];
    if (!id) { res.status(400).json({ error: "ID required" }); return; }
    const retro = getRetrospective(id);
    if (!retro) { res.status(404).json({ error: "Retrospective not found" }); return; }
    res.json({ retrospective: retro });
  });

  // POST /retrospectives — trigger a retrospective
  router.post("/retrospectives", async (req, res) => {
    const body = RunBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: body.error.issues }); return; }
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }

    // Use the first available agent config for the coordinator client
    const allConfigs = getAllAgentConfigs();
    const firstConfig = allConfigs.values().next().value;
    if (!firstConfig) {
      res.status(500).json({ error: "No agent configurations available" });
      return;
    }
    const coordinatorClient = getInferenceClientForAgent(firstConfig);

    // Build per-agent client map
    const agentClients = new Map<string, import("../../inference/types.js").InferenceClient>();
    for (const result of body.data.agentResults) {
      try {
        const config = getAgentConfig(result.agentId);
        agentClients.set(result.agentId, getInferenceClientForAgent(config));
      } catch {
        // Agent not found — will use placeholder reflection
      }
    }

    const retro = await runRetrospective(
      workspaceId,
      body.data.taskDescription,
      body.data.agentResults,
      coordinatorClient,
      agentClients,
    );

    res.status(201).json({ retrospective: retro });
  });

  return router;
}
