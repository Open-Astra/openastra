import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { getPool } from "../../config/postgres.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { runParamSweep } from "../../agents/param-sweep.js";
import { getAgentConfig } from "../../config/agents.js";
import { getInferenceClientForAgent } from "../../inference/factory.js";

// ── Parameter Sweep Routes ────────────────────────────────────────────
// POST /param-sweeps   — create and run a parameter sweep
// GET  /param-sweeps/:id — get sweep status and results

const CreateSweepBody = z.object({
  agentId: z.string().min(1),
  testPrompt: z.string().min(1).max(2000),
  parameterGrid: z.object({
    temperatures: z.array(z.number().min(0).max(2)).min(1).max(10).optional(),
    maxTokensList: z.array(z.number().int().min(1).max(8192)).min(1).max(10).optional(),
  }).optional(),
});

export function createParamSweepsRouter(): Router {
  const router = Router();

  // POST /param-sweeps — create and run a sweep asynchronously
  router.post("/", async (req: Request, res: Response) => {
    const { uid } = req as AuthenticatedRequest;
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = CreateSweepBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const { agentId, testPrompt, parameterGrid } = parsed.data;

    let agentConfig;
    try {
      agentConfig = getAgentConfig(agentId);
    } catch {
      res.status(404).json({ error: `Agent not found: ${agentId}` });
      return;
    }

    const pool = getPool();
    const id = randomUUID();

    const gridJson = JSON.stringify(parameterGrid ?? {
      temperatures: [0.1, 0.5, 0.7, 1.0],
      maxTokensList: [256, 512, 1024],
    });

    try {
      await pool.query(
        `INSERT INTO param_sweeps (id, workspace_id, agent_id, parameter_grid, status)
         VALUES ($1, $2, $3, $4::jsonb, 'running')`,
        [id, workspaceId, agentId, gridJson],
      );
    } catch (err) {
      console.error("[param-sweeps] Insert:", err);
      res.status(500).json({ error: "Failed to create sweep" });
      return;
    }

    void uid; // workspace auth is sufficient

    // Return immediately, run sweep in background
    res.status(202).json({ id, status: "running" });

    // Background execution (fire-and-forget with status update)
    (async () => {
      try {
        const client = getInferenceClientForAgent(agentConfig);
        const results = await runParamSweep(id, testPrompt, agentConfig, client);
        await pool.query(
          `UPDATE param_sweeps
           SET results = $1::jsonb, status = 'completed', completed_at = NOW()
           WHERE id = $2`,
          [JSON.stringify(results), id],
        );
      } catch (err) {
        console.error("[param-sweeps] Background run failed:", err);
        await pool.query(
          "UPDATE param_sweeps SET status = 'failed' WHERE id = $1",
          [id],
        ).catch(() => {});
      }
    })();
  });

  // GET /param-sweeps/:id — get sweep status and results
  router.get("/:id", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    try {
      const pool = getPool();
      const { rows } = await pool.query(
        `SELECT id, workspace_id, agent_id, parameter_grid, results,
                status, created_at, completed_at
         FROM param_sweeps
         WHERE id = $1 AND workspace_id = $2`,
        [req.params.id, workspaceId],
      );
      if (rows.length === 0) {
        res.status(404).json({ error: "Sweep not found" });
        return;
      }
      res.json({ sweep: rows[0] });
    } catch (err) {
      console.error("[param-sweeps] Get:", err);
      res.status(500).json({ error: "Failed to get sweep" });
    }
  });

  return router;
}
