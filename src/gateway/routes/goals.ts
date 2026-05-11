import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { getPool } from "../../config/postgres.js";
import { randomUUID } from "node:crypto";

const CreateGoalBody = z.object({
  agentId: z.string().min(1),
  title: z.string().min(1).max(500),
  description: z.string().max(2000).optional(),
  targetMetrics: z.record(z.string(), z.unknown()).optional(),
});

const UpdateGoalBody = z.object({
  status: z.enum(["active", "completed", "cancelled"]).optional(),
  progress: z.record(z.string(), z.unknown()).optional(),
});

export function createGoalsRouter(): Router {
  const router = Router();

  // GET /goals — list goals for current uid + workspace
  router.get("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.json({ goals: [] });
      return;
    }

    const uid = (req as any).user?.uid ?? "";

    try {
      const pool = getPool();
      const result = await pool.query(
        `SELECT id, workspace_id, agent_id, uid, title, description, status,
                target_metrics, progress, created_at, updated_at
         FROM agent_goals
         WHERE workspace_id = $1 AND uid = $2
         ORDER BY created_at DESC`,
        [workspaceId, uid],
      );
      res.json({ goals: result.rows });
    } catch (err) {
      console.error("[goals] List:", err);
      res.status(500).json({ error: "Failed to list goals" });
    }
  });

  // POST /goals — create a new goal
  router.post("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = CreateGoalBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const uid = (req as any).user?.uid ?? "";
    const { agentId, title, description, targetMetrics } = parsed.data;

    try {
      const pool = getPool();
      const id = randomUUID();
      const result = await pool.query<{ id: string; created_at: Date }>(
        `INSERT INTO agent_goals (id, workspace_id, agent_id, uid, title, description, target_metrics)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         RETURNING id, created_at`,
        [
          id,
          workspaceId,
          agentId,
          uid,
          title,
          description ?? "",
          JSON.stringify(targetMetrics ?? {}),
        ],
      );
      res.status(201).json({ id: result.rows[0].id, createdAt: result.rows[0].created_at });
    } catch (err) {
      console.error("[goals] Create:", err);
      res.status(500).json({ error: "Failed to create goal" });
    }
  });

  // PATCH /goals/:id — update goal status or progress
  router.patch("/:id", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = UpdateGoalBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    try {
      const pool = getPool();
      const sets: string[] = ["updated_at = NOW()"];
      const params: unknown[] = [];
      let idx = 1;

      if (parsed.data.status !== undefined) {
        sets.push(`status = $${idx++}`);
        params.push(parsed.data.status);
      }
      if (parsed.data.progress !== undefined) {
        sets.push(`progress = progress || $${idx++}::jsonb`);
        params.push(JSON.stringify(parsed.data.progress));
      }

      params.push(req.params.id, workspaceId);
      const result = await pool.query(
        `UPDATE agent_goals SET ${sets.join(", ")}
         WHERE id = $${idx++} AND workspace_id = $${idx++}
         RETURNING id`,
        params,
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: "Goal not found" });
        return;
      }
      res.json({ message: "Goal updated" });
    } catch (err) {
      console.error("[goals] Update:", err);
      res.status(500).json({ error: "Failed to update goal" });
    }
  });

  // DELETE /goals/:id — delete a goal
  router.delete("/:id", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    try {
      const pool = getPool();
      const result = await pool.query(
        `DELETE FROM agent_goals WHERE id = $1 AND workspace_id = $2 RETURNING id`,
        [req.params.id, workspaceId],
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: "Goal not found" });
        return;
      }
      res.json({ message: "Goal deleted" });
    } catch (err) {
      console.error("[goals] Delete:", err);
      res.status(500).json({ error: "Failed to delete goal" });
    }
  });

  return router;
}
