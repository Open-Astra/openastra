import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { getAgentConfig } from "../../config/agents.js";
import { forecastTokenUsage } from "../../agents/budget-forecast.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";

// ── Budget Forecast Router ────────────────────────────────────────────
// Estimates token usage before sending a message to an agent.
//   POST /budget-forecast — { agentId, message, sessionId? } → TokenForecast

const ForecastBody = z.object({
  agentId: z.string().min(1).max(128),
  message: z.string().min(1).max(100_000),
  sessionId: z.string().optional(),
});

export function createBudgetForecastRouter(): Router {
  const router = Router();

  // POST /budget-forecast — forecast token usage for an agent + message
  router.post("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = ForecastBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const { agentId, message, sessionId } = parsed.data;
    const resolvedSessionId = sessionId ?? randomUUID();

    let agentConfig;
    try {
      agentConfig = getAgentConfig(agentId);
    } catch {
      res.status(404).json({ error: `Agent not found: ${agentId}` });
      return;
    }

    try {
      const forecast = await forecastTokenUsage(
        workspaceId,
        agentConfig,
        message,
        resolvedSessionId,
      );
      res.json(forecast);
    } catch (err) {
      console.error("[budget-forecast] Forecast:", err);
      res.status(500).json({ error: "Failed to compute token forecast" });
    }
  });

  return router;
}
