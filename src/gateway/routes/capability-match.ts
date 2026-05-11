import { Router } from "express";
import { z } from "zod";
import { negotiateBestAgent, getAgentCapabilities } from "../../agents/capability-negotiator.js";
import { getAllAgentConfigs } from "../../config/agents.js";

const MatchBody = z.object({
  requiredTools: z.array(z.string()).default([]),
  requiredSkills: z.array(z.string()).default([]),
});

export function createCapabilityMatchRouter(): Router {
  const router = Router();

  // POST /agents/match — find best agent for required tools/skills
  router.post("/agents/match", async (req, res) => {
    const body = MatchBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.issues });
      return;
    }
    const result = await negotiateBestAgent(body.data.requiredTools, body.data.requiredSkills);
    if (!result || result.missingTools.length > 0 || result.missingSkills.length > 0) {
      res.status(404).json({
        error: "No agent fully satisfies the required tools/skills",
        bestPartialMatch: result ?? null,
      });
      return;
    }
    res.json(result);
  });

  // GET /agents/:agentId/capabilities — get tools + skills for an agent
  router.get("/agents/:agentId/capabilities", (req, res) => {
    const { agentId } = req.params as { agentId: string };
    try {
      const caps = getAgentCapabilities(agentId);
      res.json(caps);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(404).json({ error: msg });
    }
  });

  // GET /agents/capabilities — list all agents with capabilities
  router.get("/agents/capabilities", (_req, res) => {
    const agents = Array.from(getAllAgentConfigs().values());
    const result = agents.map((a) => {
      try {
        return getAgentCapabilities(a.id);
      } catch {
        return { agentId: a.id, tools: a.tools.allow, skills: a.skills ?? [] };
      }
    });
    res.json({ agents: result });
  });

  return router;
}
