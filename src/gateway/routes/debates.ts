import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { getAgentConfig } from "../../config/agents.js";
import { getInferenceClientForAgent } from "../../inference/factory.js";
import { runStructuredDebate } from "../../agents/debate.js";
import { getPool } from "../../config/postgres.js";

const StartDebateBody = z.object({
  topic: z.string().min(1).max(1000),
  agentAId: z.string().min(1),
  agentBId: z.string().min(1),
  judgeAgentId: z.string().min(1),
});

export function createDebateRouter(): Router {
  const router = Router();

  // POST /debates — start a structured debate
  router.post("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = StartDebateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const { topic, agentAId, agentBId, judgeAgentId } = parsed.data;

    try {
      const agentAConfig = getAgentConfig(agentAId);
      const agentBConfig = getAgentConfig(agentBId);
      const judgeConfig = getAgentConfig(judgeAgentId);

      const clientA = getInferenceClientForAgent(agentAConfig);
      const clientB = getInferenceClientForAgent(agentBConfig);
      const clientJudge = getInferenceClientForAgent(judgeConfig);

      const result = await runStructuredDebate(
        topic,
        agentAConfig,
        agentBConfig,
        judgeConfig,
        clientA,
        clientB,
        clientJudge,
        workspaceId,
      );

      res.status(201).json(result);
    } catch (err) {
      console.error("[debates] Start:", err);
      if (err instanceof Error && err.message.startsWith("Unknown agent:")) {
        res.status(404).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Failed to start debate" });
    }
  });

  // GET /debates/:id — get debate session by id
  router.get("/:id", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    try {
      const pool = getPool();
      const result = await pool.query(
        `SELECT id, workspace_id, topic, agent_a_id, agent_b_id, judge_agent_id,
                status, synthesis, created_at
         FROM debate_sessions
         WHERE id = $1 AND workspace_id = $2`,
        [req.params.id, workspaceId],
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: "Debate not found" });
        return;
      }

      res.json({ debate: result.rows[0] });
    } catch (err) {
      console.error("[debates] Get:", err);
      res.status(500).json({ error: "Failed to get debate" });
    }
  });

  return router;
}
