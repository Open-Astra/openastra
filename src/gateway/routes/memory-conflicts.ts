import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { getPool } from "../../config/postgres.js";

const ResolveBody = z.object({
  resolution: z.string().min(1).max(2000),
});

const ListQuery = z.object({
  status: z.enum(["open", "resolved", "dismissed"]).optional(),
  uid: z.string().optional(),
});

export function createMemoryConflictsRouter(): Router {
  const router = Router();

  // GET / — list conflicts for workspace
  router.get("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.json({ conflicts: [] });
      return;
    }

    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.format() });
      return;
    }

    const status = parsed.data.status ?? "open";
    const uid = parsed.data.uid;

    try {
      const pool = getPool();
      const params: unknown[] = [workspaceId, status];
      let sql = `SELECT id, workspace_id, uid, fact_a, fact_b, source_a, source_b, status, resolution, created_at
                 FROM memory_conflicts
                 WHERE workspace_id = $1 AND status = $2`;

      if (uid) {
        params.push(uid);
        sql += ` AND uid = $${params.length}`;
      }
      sql += ` ORDER BY created_at DESC LIMIT 100`;

      const result = await pool.query(sql, params);
      res.json({ conflicts: result.rows });
    } catch (err) {
      console.error("[memory-conflicts] List:", err);
      res.status(500).json({ error: "Failed to list conflicts" });
    }
  });

  // POST /:id/resolve — resolve a conflict
  router.post("/:id/resolve", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = ResolveBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    try {
      const pool = getPool();
      const result = await pool.query(
        `UPDATE memory_conflicts
         SET status = 'resolved', resolution = $3
         WHERE id = $1 AND workspace_id = $2
         RETURNING id, status, resolution`,
        [req.params.id, workspaceId, parsed.data.resolution],
      );
      if (result.rowCount === 0) {
        res.status(404).json({ error: "Conflict not found" });
        return;
      }
      res.json({ conflict: result.rows[0] });
    } catch (err) {
      console.error("[memory-conflicts] Resolve:", err);
      res.status(500).json({ error: "Failed to resolve conflict" });
    }
  });

  // POST /:id/dismiss — dismiss a conflict
  router.post("/:id/dismiss", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    try {
      const pool = getPool();
      const result = await pool.query(
        `UPDATE memory_conflicts
         SET status = 'dismissed'
         WHERE id = $1 AND workspace_id = $2
         RETURNING id, status`,
        [req.params.id, workspaceId],
      );
      if (result.rowCount === 0) {
        res.status(404).json({ error: "Conflict not found" });
        return;
      }
      res.json({ conflict: result.rows[0] });
    } catch (err) {
      console.error("[memory-conflicts] Dismiss:", err);
      res.status(500).json({ error: "Failed to dismiss conflict" });
    }
  });

  return router;
}
