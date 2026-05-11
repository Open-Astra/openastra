import { Router, type Request, type Response } from "express";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { getPool } from "../../config/postgres.js";

export function createApprovalsRouter(): Router {
  const router = Router();

  // GET /approvals — list approval requests for workspace
  router.get("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const status = req.query["status"] as string | undefined;
    const validStatuses = ["pending", "approved", "rejected", "expired"];
    if (status && !validStatuses.includes(status)) {
      res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` });
      return;
    }

    try {
      const conditions = ["workspace_id = $1"];
      const values: unknown[] = [workspaceId];
      let paramIdx = 2;

      if (status) {
        conditions.push(`status = $${paramIdx++}`);
        values.push(status);
      }

      const { rows } = await getPool().query(
        `SELECT id, workspace_id, session_id, agent_id, uid, tool_name, tool_args, status,
                expires_at, reviewed_by, reviewed_at, created_at
         FROM approval_requests
         WHERE ${conditions.join(" AND ")}
         ORDER BY created_at DESC
         LIMIT 100`,
        values,
      );

      res.json({ approvals: rows });
    } catch (err) {
      console.error("[approvals] List:", err);
      res.status(500).json({ error: "Failed to list approval requests" });
    }
  });

  // POST /approvals/:id/approve
  router.post("/:id/approve", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const uid = (req as any).user?.uid as string | undefined;
    if (!uid) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    try {
      const { rowCount } = await getPool().query(
        `UPDATE approval_requests
         SET status = 'approved', reviewed_by = $1, reviewed_at = NOW()
         WHERE id = $2 AND workspace_id = $3 AND status = 'pending'`,
        [uid, req.params["id"], workspaceId],
      );

      if ((rowCount ?? 0) === 0) {
        res.status(404).json({ error: "Approval request not found or not pending" });
        return;
      }

      res.json({ message: "Approval granted" });
    } catch (err) {
      console.error("[approvals] Approve:", err);
      res.status(500).json({ error: "Failed to approve request" });
    }
  });

  // POST /approvals/:id/reject
  router.post("/:id/reject", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const uid = (req as any).user?.uid as string | undefined;
    if (!uid) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    try {
      const { rowCount } = await getPool().query(
        `UPDATE approval_requests
         SET status = 'rejected', reviewed_by = $1, reviewed_at = NOW()
         WHERE id = $2 AND workspace_id = $3 AND status = 'pending'`,
        [uid, req.params["id"], workspaceId],
      );

      if ((rowCount ?? 0) === 0) {
        res.status(404).json({ error: "Approval request not found or not pending" });
        return;
      }

      res.json({ message: "Approval rejected" });
    } catch (err) {
      console.error("[approvals] Reject:", err);
      res.status(500).json({ error: "Failed to reject request" });
    }
  });

  return router;
}
