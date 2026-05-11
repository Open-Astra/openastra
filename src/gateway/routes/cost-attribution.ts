import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { getPool } from "../../config/postgres.js";

const CostAttributionQuery = z.object({
  group_by: z.enum(["agent", "user", "day"]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export function createCostAttributionRouter(): Router {
  const router = Router();

  // GET /cost-attribution — aggregated cost attribution for workspace
  router.get("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = CostAttributionQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.format() });
      return;
    }

    const { group_by = "agent", from, to } = parsed.data;

    try {
      const pool = getPool();
      const params: unknown[] = [workspaceId];
      const conditions: string[] = ["workspace_id = $1"];

      if (from) {
        params.push(from);
        conditions.push(`day >= $${params.length}`);
      }
      if (to) {
        params.push(to);
        conditions.push(`day <= $${params.length}`);
      }

      const where = conditions.join(" AND ");

      let selectCol: string;
      let groupCol: string;
      if (group_by === "agent") {
        selectCol = "agent_id AS group_key";
        groupCol = "agent_id";
      } else if (group_by === "user") {
        selectCol = "uid AS group_key";
        groupCol = "uid";
      } else {
        selectCol = "day::TEXT AS group_key";
        groupCol = "day";
      }

      const sql = `
        SELECT
          ${selectCol},
          SUM(prompt_tokens) AS prompt_tokens,
          SUM(completion_tokens) AS completion_tokens,
          SUM(cost_usd) AS cost_usd
        FROM cost_attribution
        WHERE ${where}
        GROUP BY ${groupCol}
        ORDER BY cost_usd DESC
      `;

      const result = await pool.query(sql, params);
      res.json({ group_by, rows: result.rows });
    } catch (err) {
      console.error("[cost-attribution] Query:", err);
      res.status(500).json({ error: "Failed to query cost attribution" });
    }
  });

  return router;
}
