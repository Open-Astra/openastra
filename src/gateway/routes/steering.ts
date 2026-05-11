import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { getPool } from "../../config/postgres.js";

const SteerBody = z.object({
  nudge: z.string().min(1).max(2000),
  appendToSystem: z.boolean().default(true),
});

export function createSteeringRouter(): Router {
  const router = Router();

  // POST /sessions/:id/steer — inject a steering nudge into an active session
  router.post("/:id/steer", async (req: Request, res: Response) => {
    const workspace = (req as unknown as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = SteerBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const sessionId = req.params["id"] as string;
    const pool = getPool();

    try {
      // Verify session exists and belongs to this workspace
      const sessionResult = await pool.query<{ id: string; status: string }>(
        `SELECT id, status FROM sessions WHERE id = $1 AND workspace_id = $2`,
        [sessionId, workspaceId],
      );

      if (sessionResult.rows.length === 0) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      // Insert steer record
      const insertResult = await pool.query<{ id: string; session_id: string; nudge: string; created_at: Date }>(
        `INSERT INTO session_steers (session_id, nudge, append_to_system)
         VALUES ($1, $2, $3)
         RETURNING id, session_id, nudge, created_at`,
        [sessionId, parsed.data.nudge, parsed.data.appendToSystem],
      );

      const row = insertResult.rows[0]!;
      res.status(201).json({
        id: row.id,
        sessionId: row.session_id,
        nudge: row.nudge,
        createdAt: row.created_at,
      });
    } catch (err) {
      console.error("[steering] POST /:id/steer:", err);
      res.status(500).json({ error: "Failed to create steer" });
    }
  });

  return router;
}
