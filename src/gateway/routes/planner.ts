import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { runPlannerMode } from "../../agents/planner.js";
import { getAgentConfig } from "../../config/agents.js";
import { getInferenceClientForAgent } from "../../inference/factory.js";

// ── Planner Routes ────────────────────────────────────────────────────
// POST /planner/run — runs the multi-turn planner for a goal

const RunPlannerBody = z.object({
  goal: z.string().min(1).max(4000),
  agentId: z.string().min(1),
});

export function createPlannerRouter(): Router {
  const router = Router();

  // POST /planner/run
  router.post("/run", async (req: Request, res: Response) => {
    const { uid } = req as AuthenticatedRequest;
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;

    const parsed = RunPlannerBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const { goal, agentId } = parsed.data;

    let agentConfig;
    try {
      agentConfig = getAgentConfig(agentId);
    } catch {
      res.status(404).json({ error: `Agent not found: ${agentId}` });
      return;
    }

    let client;
    try {
      client = getInferenceClientForAgent(agentConfig);
    } catch (err) {
      console.error("[planner] Failed to get inference client:", err);
      res.status(500).json({ error: "Failed to initialize inference client" });
      return;
    }

    const sessionId = randomUUID();
    const ctx = { uid, sessionId, workspaceId: workspaceId ?? undefined };

    try {
      const result = await runPlannerMode(goal, agentConfig, client, ctx);
      res.json(result);
    } catch (err) {
      console.error("[planner] Run failed:", err);
      res.status(500).json({ error: "Planner run failed" });
    }
  });

  return router;
}
