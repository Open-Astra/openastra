import { Router, type Request, type Response } from "express";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { getPool } from "../../config/postgres.js";

export function createMemoryNamespacesRouter(): Router {
  const router = Router();

  // GET / — list namespaces for workspace
  router.get("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.json({ namespaces: [] });
      return;
    }

    try {
      const pool = getPool();
      const result = await pool.query<{ namespace: string }>(
        `SELECT DISTINCT namespace FROM daily_memory WHERE workspace_id::text = $1 ORDER BY namespace`,
        [workspaceId],
      );
      res.json({ namespaces: result.rows.map((r) => r.namespace) });
    } catch (err) {
      console.error("[memory-namespaces] List:", err);
      res.status(500).json({ error: "Failed to list namespaces" });
    }
  });

  // DELETE /:name — delete all daily memory in a namespace
  router.delete("/:name", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const namespaceName = req.params.name;
    if (!namespaceName) {
      res.status(400).json({ error: "Namespace name required" });
      return;
    }

    try {
      const pool = getPool();
      const result = await pool.query(
        `DELETE FROM daily_memory WHERE workspace_id::text = $1 AND namespace = $2`,
        [workspaceId, namespaceName],
      );
      res.json({ deleted: result.rowCount ?? 0 });
    } catch (err) {
      console.error("[memory-namespaces] Delete:", err);
      res.status(500).json({ error: "Failed to delete namespace" });
    }
  });

  return router;
}
