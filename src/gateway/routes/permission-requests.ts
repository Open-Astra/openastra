import { Router, type Request, type Response } from "express";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { getPool } from "../../config/postgres.js";

interface PermissionRequestRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  uid: string;
  requested_tools: string[];
  reason: string;
  status: string;
  reviewed_by: string | null;
  created_at: string;
}

export function createPermissionRequestsRouter(): Router {
  const router = Router();

  // GET / — list pending permission requests for workspace
  router.get("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    try {
      const result = await getPool().query<PermissionRequestRow>(
        `SELECT id, workspace_id, agent_id, uid, requested_tools, reason, status, reviewed_by, created_at
         FROM tool_permission_requests
         WHERE workspace_id = $1 AND status = 'pending'
         ORDER BY created_at DESC`,
        [workspaceId],
      );

      res.json({ requests: result.rows });
    } catch (err) {
      console.error("[permission-requests] GET:", err);
      res.status(500).json({ error: "Failed to list permission requests" });
    }
  });

  // POST /:id/approve — approve a permission request
  router.post("/:id/approve", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const { id } = req.params as { id: string };

    try {
      const result = await getPool().query(
        `UPDATE tool_permission_requests
         SET status = 'approved', reviewed_by = $3
         WHERE id = $1 AND workspace_id = $2 AND status = 'pending'
         RETURNING id`,
        [id, workspaceId, (req as any).uid ?? "unknown"],
      );

      if (result.rowCount === 0) {
        res.status(404).json({ error: "Permission request not found or not pending" });
        return;
      }

      res.json({ message: "Permission request approved", id });
    } catch (err) {
      console.error("[permission-requests] approve:", err);
      res.status(500).json({ error: "Failed to approve permission request" });
    }
  });

  // POST /:id/reject — reject a permission request
  router.post("/:id/reject", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const { id } = req.params as { id: string };

    try {
      const result = await getPool().query(
        `UPDATE tool_permission_requests
         SET status = 'rejected', reviewed_by = $3
         WHERE id = $1 AND workspace_id = $2 AND status = 'pending'
         RETURNING id`,
        [id, workspaceId, (req as any).uid ?? "unknown"],
      );

      if (result.rowCount === 0) {
        res.status(404).json({ error: "Permission request not found or not pending" });
        return;
      }

      res.json({ message: "Permission request rejected", id });
    } catch (err) {
      console.error("[permission-requests] reject:", err);
      res.status(500).json({ error: "Failed to reject permission request" });
    }
  });

  return router;
}
