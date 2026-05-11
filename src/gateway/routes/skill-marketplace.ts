import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { getPool } from "../../config/postgres.js";

const ListSkillsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const SubscribeBody = z.object({
  pinned_version: z.string().optional(),
});

export function createSkillMarketplaceRouter(): Router {
  const router = Router();

  // GET / — list all workspace_skills (paginated)
  router.get("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = ListSkillsQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.format() });
      return;
    }

    const limit = parsed.data.limit ?? 50;
    const offset = parsed.data.offset ?? 0;

    try {
      const pool = getPool();
      const result = await pool.query(
        `SELECT id, workspace_id, name, description, version, manifest, source_url, published_by, created_at
         FROM workspace_skills
         WHERE workspace_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [workspaceId, limit, offset],
      );
      const countResult = await pool.query(
        `SELECT COUNT(*) AS total FROM workspace_skills WHERE workspace_id = $1`,
        [workspaceId],
      );
      res.json({
        skills: result.rows,
        total: parseInt(countResult.rows[0]?.total ?? "0", 10),
        limit,
        offset,
      });
    } catch (err) {
      console.error("[skill-marketplace] List:", err);
      res.status(500).json({ error: "Failed to list skills" });
    }
  });

  // POST /:id/subscribe — subscribe workspace to a skill
  router.post("/:id/subscribe", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const { id } = req.params as { id: string };

    const parsed = SubscribeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    try {
      const pool = getPool();
      await pool.query(
        `INSERT INTO skill_subscriptions (workspace_id, skill_id, pinned_version)
         VALUES ($1, $2, $3)
         ON CONFLICT (workspace_id, skill_id) DO UPDATE SET pinned_version = EXCLUDED.pinned_version`,
        [workspaceId, id, parsed.data.pinned_version ?? null],
      );
      res.status(201).json({ message: "Subscribed to skill", skillId: id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("violates foreign key")) {
        res.status(404).json({ error: "Skill not found" });
        return;
      }
      console.error("[skill-marketplace] Subscribe:", err);
      res.status(500).json({ error: "Failed to subscribe to skill" });
    }
  });

  // DELETE /:id/unsubscribe — unsubscribe workspace from a skill
  router.delete("/:id/unsubscribe", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const { id } = req.params as { id: string };

    try {
      const pool = getPool();
      const result = await pool.query(
        `DELETE FROM skill_subscriptions WHERE workspace_id = $1 AND skill_id = $2`,
        [workspaceId, id],
      );
      if (result.rowCount === 0) {
        res.status(404).json({ error: "Subscription not found" });
        return;
      }
      res.json({ message: "Unsubscribed from skill", skillId: id });
    } catch (err) {
      console.error("[skill-marketplace] Unsubscribe:", err);
      res.status(500).json({ error: "Failed to unsubscribe from skill" });
    }
  });

  return router;
}
