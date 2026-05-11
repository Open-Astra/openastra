import { Router, type Request, type Response } from "express";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { getPool } from "../../config/postgres.js";

export function createSpawnTreeRouter(): Router {
  const router = Router();

  // GET /spawn-tree?traceId=xxx — get spawn tree for a root trace
  router.get("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const traceId = req.query.traceId as string | undefined;
    if (!traceId) {
      res.status(400).json({ error: "traceId query parameter required" });
      return;
    }

    try {
      const pool = getPool();
      const result = await pool.query(
        `SELECT id, workspace_id, root_trace_id, parent_trace_id, child_trace_id,
                parent_agent_id, child_agent_id, spawned_at, depth, total_cost_usd
         FROM agent_spawn_tree
         WHERE workspace_id = $1 AND root_trace_id = $2
         ORDER BY depth ASC, spawned_at ASC`,
        [workspaceId, traceId],
      );

      res.json({ tree: result.rows });
    } catch (err) {
      console.error("[spawn-tree] Get:", err);
      res.status(500).json({ error: "Failed to get spawn tree" });
    }
  });

  return router;
}
