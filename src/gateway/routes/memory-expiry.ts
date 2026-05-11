import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { getPool } from "../../config/postgres.js";

const ExpiryPoliciesBody = z.object({
  rules: z.array(
    z.object({
      category: z.string().min(1),
      ttlDays: z.number().int().positive(),
    }),
  ),
});

export function createMemoryExpiryRouter(): Router {
  const router = Router();

  // GET / — get expiry policies for workspace
  router.get("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.json({ rules: [] });
      return;
    }

    try {
      const pool = getPool();
      const result = await pool.query<{ rules: unknown }>(
        `SELECT rules FROM memory_expiry_policies WHERE workspace_id = $1`,
        [workspaceId],
      );
      res.json({ rules: result.rows[0]?.rules ?? [] });
    } catch (err) {
      console.error("[memory-expiry] Get:", err);
      res.status(500).json({ error: "Failed to get expiry policies" });
    }
  });

  // PUT / — upsert expiry policies for workspace
  router.put("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = ExpiryPoliciesBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    try {
      const pool = getPool();
      await pool.query(
        `INSERT INTO memory_expiry_policies (workspace_id, rules, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (workspace_id) DO UPDATE
           SET rules = $2::jsonb, updated_at = NOW()`,
        [workspaceId, JSON.stringify(parsed.data.rules)],
      );
      res.json({ rules: parsed.data.rules });
    } catch (err) {
      console.error("[memory-expiry] Put:", err);
      res.status(500).json({ error: "Failed to update expiry policies" });
    }
  });

  return router;
}
