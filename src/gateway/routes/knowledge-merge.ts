// Mount: app.use("/memory/knowledge-merge", jwtAuth(), workspaceResolver(), createKnowledgeMergeRouter())

import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { getPool } from "../../config/postgres.js";
import { mergeKnowledge } from "../../memory/knowledge-merge.js";

const CreateMergeBody = z.object({
  uid: z.string().min(1),
  sourceWorkspaceId: z.string().min(1),
  mergeType: z.enum(["graph_entities"]).optional().default("graph_entities"),
  filters: z.record(z.string(), z.unknown()).optional(),
});

export function createKnowledgeMergeRouter(): Router {
  const router = Router();

  // POST /memory/knowledge-merge — initiate a cross-workspace merge
  router.post("/", async (req, res) => {
    const r = req as unknown as AuthenticatedRequest & WorkspaceAwareRequest;
    const targetWorkspaceId = r.workspace?.workspaceId ?? r.uid;

    const parsed = CreateMergeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.format() });
      return;
    }

    const { uid, sourceWorkspaceId, mergeType, filters } = parsed.data;
    const requestId = randomUUID();
    const pool = getPool();

    // Create request record
    await pool
      .query(
        `INSERT INTO knowledge_merge_requests
           (id, source_workspace_id, target_workspace_id, uid, status, merge_type, filters)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6::jsonb)`,
        [requestId, sourceWorkspaceId, targetWorkspaceId, uid, mergeType, JSON.stringify(filters ?? {})],
      )
      .catch((err: unknown) => {
        console.error("[knowledge-merge] Failed to insert request:", err);
      });

    // Run merge fire-and-forget (may be slow for large datasets)
    mergeKnowledge(requestId, sourceWorkspaceId, targetWorkspaceId, uid, pool).catch((err: unknown) => {
      console.error("[knowledge-merge] Merge failed:", err);
    });

    res.status(202).json({ requestId, status: "pending" });
  });

  // GET /memory/knowledge-merge/:id — get merge status
  router.get("/:id", async (req, res) => {
    const r = req as unknown as AuthenticatedRequest & WorkspaceAwareRequest;
    const targetWorkspaceId = r.workspace?.workspaceId ?? r.uid;
    const pool = getPool();

    const { rows } = await pool
      .query(
        `SELECT id, source_workspace_id, target_workspace_id, uid, status, merge_type,
                filters, merged_count, created_at, completed_at
         FROM knowledge_merge_requests
         WHERE id = $1 AND target_workspace_id = $2`,
        [req.params.id, targetWorkspaceId],
      )
      .catch(() => ({ rows: [] as unknown[] })) as { rows: Array<Record<string, unknown>> };

    if (rows.length === 0) {
      res.status(404).json({ error: "Merge request not found" });
      return;
    }

    const row = rows[0]!;
    res.json({
      id: row.id,
      sourceWorkspaceId: row.source_workspace_id,
      targetWorkspaceId: row.target_workspace_id,
      uid: row.uid,
      status: row.status,
      mergeType: row.merge_type,
      filters: row.filters,
      mergedCount: row.merged_count,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    });
  });

  return router;
}
