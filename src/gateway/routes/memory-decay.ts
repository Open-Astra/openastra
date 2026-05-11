import { Router } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { getPool } from "../../config/postgres.js";
import { rankMemoriesByImportance, pruneByImportance } from "../../memory/decay.js";

const PruneBody = z.object({
  userId: z.string().optional(),
  keepTopN: z.number().int().min(1).max(10000),
  dryRun: z.boolean().default(true),
});

export function createMemoryDecayRouter(): Router {
  const router = Router();
  const pool = () => getPool();

  // GET /memory/decay-scores — return memories sorted by importance score
  router.get("/memory/decay-scores", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    const uid = (req as unknown as AuthenticatedRequest).uid;
    const userId = (req.query["userId"] as string) ?? uid;
    const limit = Math.min(parseInt(String(req.query["limit"] ?? "50"), 10), 500);

    const { rows } = await pool().query<{
      date: string;
      created_at: string;
      access_count: number;
    }>(
      `SELECT date, created_at, COALESCE(access_count, 0) AS access_count
       FROM daily_memory
       WHERE user_id = $1 AND workspace_id IS NOT DISTINCT FROM $2
       LIMIT $3`,
      [userId, workspaceId, limit * 2],
    );

    const ranked = rankMemoriesByImportance(
      rows.map((r) => ({ ...r, created_at: r.created_at ?? r.date })),
    ).slice(0, limit);

    res.json({ memories: ranked, count: ranked.length });
  });

  // POST /memory/prune — prune low-importance memories
  router.post("/memory/prune", async (req, res) => {
    const body = PruneBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: body.error.issues }); return; }

    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    const uid = (req as unknown as AuthenticatedRequest).uid;
    const userId = body.data.userId ?? uid;

    const { rows } = await pool().query<{
      date: string;
      created_at: string;
      access_count: number;
    }>(
      `SELECT date, created_at, COALESCE(access_count, 0) AS access_count
       FROM daily_memory
       WHERE user_id = $1 AND workspace_id IS NOT DISTINCT FROM $2 AND pinned = false`,
      [userId, workspaceId],
    );

    const keep = new Set(pruneByImportance(
      rows.map((r) => ({ ...r, created_at: r.created_at ?? r.date })),
      body.data.keepTopN,
    ).map((r) => r.date));

    const toPrune = rows.filter((r) => !keep.has(r.date));

    if (body.data.dryRun) {
      res.json({ dryRun: true, wouldDelete: toPrune.length });
      return;
    }

    let deleted = 0;
    for (const row of toPrune) {
      const { rowCount } = await pool().query(
        `DELETE FROM daily_memory WHERE user_id = $1 AND date = $2 AND workspace_id IS NOT DISTINCT FROM $3 AND pinned = false`,
        [userId, row.date, workspaceId],
      );
      deleted += rowCount ?? 0;
    }

    res.json({ deleted, kept: rows.length - deleted });
  });

  return router;
}
