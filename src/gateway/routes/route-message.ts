import { Router } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { routeToSpecialist } from "../../agents/specialization-router.js";
import { getAllAgentConfigs } from "../../config/agents.js";

const RouteMessageBody = z.object({
  message: z.string().min(1).max(10000),
});

export function createRouteMessageRouter(): Router {
  const router = Router();

  // POST /route-message — route a message to the best specialist agent
  router.post("/route-message", async (req, res) => {
    const parsed = RouteMessageBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
      return;
    }

    // uid available from auth middleware if needed for filtering
    void (req as unknown as AuthenticatedRequest).uid;

    try {
      const allConfigs = getAllAgentConfigs();
      const agents = Array.from(allConfigs.values());

      if (agents.length === 0) {
        res.status(404).json({ error: "No agents available for routing" });
        return;
      }

      const result = await routeToSpecialist(parsed.data.message, agents);
      const agentConfig = allConfigs.get(result.agentId);

      res.json({
        agentId: result.agentId,
        score: result.score,
        agentName: agentConfig?.displayName ?? result.agentId,
        reasoning: result.reasoning,
      });
    } catch (err) {
      console.error("[route-message]", err);
      res.status(500).json({ error: "Failed to route message" });
    }
  });

  return router;
}
