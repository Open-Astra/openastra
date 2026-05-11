import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { getPool } from "../../config/postgres.js";
import { jwtAuth } from "../middleware/auth.js";
import { workspaceResolver } from "../middleware/workspace.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";

// ── Webhook Inspector Router ──────────────────────────────────────────
// Paginated view of outbound webhook dispatch history (workspace-scoped).
// Maximum 200 entries returned per request.

const InspectorQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  eventType: z.string().optional(),
});

export function createWebhookInspectorRouter(): Router {
  const router = Router();
  router.use(jwtAuth(), workspaceResolver());

  // GET /webhook-inspector
  router.get("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = InspectorQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.format() });
      return;
    }

    const { limit, offset, eventType } = parsed.data;
    const conditions: string[] = ["workspace_id = $1"];
    const values: unknown[] = [workspaceId];
    let idx = 2;

    if (eventType) {
      conditions.push(`event_type = $${idx++}`);
      values.push(eventType);
    }

    const where = conditions.join(" AND ");

    try {
      const pool = getPool();

      const [rowsResult, countResult] = await Promise.all([
        pool.query(
          `SELECT id, workspace_id, webhook_url, event_type, payload,
                  response_status, response_body, duration_ms, created_at
           FROM webhook_log
           WHERE ${where}
           ORDER BY created_at DESC
           LIMIT $${idx++} OFFSET $${idx}`,
          [...values, limit, offset],
        ),
        pool.query(
          `SELECT COUNT(*) AS total FROM webhook_log WHERE ${where}`,
          values,
        ),
      ]);

      res.json({
        logs: rowsResult.rows,
        total: parseInt(countResult.rows[0]?.total ?? "0", 10),
        limit,
        offset,
      });
    } catch (err) {
      console.error("[webhook-inspector] List:", err);
      res.status(500).json({ error: "Failed to list webhook logs" });
    }
  });

  // GET /webhook-inspector/:id
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
        `SELECT id, workspace_id, webhook_url, event_type, payload,
                response_status, response_body, duration_ms, created_at
         FROM webhook_log
         WHERE id = $1 AND workspace_id = $2`,
        [req.params.id, workspaceId],
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: "Webhook log entry not found" });
        return;
      }

      res.json({ log: result.rows[0] });
    } catch (err) {
      console.error("[webhook-inspector] Get:", err);
      res.status(500).json({ error: "Failed to get webhook log entry" });
    }
  });

  return router;
}
