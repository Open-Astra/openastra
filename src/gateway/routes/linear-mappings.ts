// Mount: app.use("/linear-mappings", jwtAuth(), workspaceResolver(), createLinearMappingsRouter()); in gateway/index.ts

import { Router } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { getPool } from "../../config/postgres.js";

// ── Request Validation ──────────────────────────────────────────────

const CreateMappingBody = z.object({
  labelName: z.string().min(1).max(128),
  agentId: z.string().min(1),
});

const UpdateMappingBody = z.object({
  labelName: z.string().min(1).max(128).optional(),
  agentId: z.string().min(1).optional(),
});

// ── Helper ───────────────────────────────────────────────────────────

function resolveWorkspaceId(req: WorkspaceAwareRequest & AuthenticatedRequest): string {
  return req.workspace.workspaceId ?? req.uid;
}

// ── Router ───────────────────────────────────────────────────────────

export function createLinearMappingsRouter(): Router {
  const router = Router();

  // GET /linear-mappings — list all mappings for the workspace
  router.get("/", async (req, res) => {
    const r = req as unknown as WorkspaceAwareRequest & AuthenticatedRequest;
    const workspaceId = resolveWorkspaceId(r);

    try {
      const { rows } = await getPool().query(
        `SELECT * FROM linear_label_agent_mappings WHERE workspace_id = $1 ORDER BY created_at DESC`,
        [workspaceId],
      );
      res.json({ mappings: rows });
    } catch (err) {
      console.error("[linear-mappings] List error:", err);
      res.status(500).json({ error: "Failed to list linear mappings" });
    }
  });

  // POST /linear-mappings — create a mapping
  router.post("/", async (req, res) => {
    const r = req as unknown as WorkspaceAwareRequest & AuthenticatedRequest;
    const parsed = CreateMappingBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const workspaceId = resolveWorkspaceId(r);
    const { labelName, agentId } = parsed.data;

    try {
      const { rows } = await getPool().query(
        `INSERT INTO linear_label_agent_mappings (workspace_id, label_name, agent_id)
         VALUES ($1, $2, $3) RETURNING *`,
        [workspaceId, labelName, agentId],
      );
      res.status(201).json(rows[0]);
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr.code === "23505") {
        res.status(409).json({ error: "A mapping for this label already exists in the workspace" });
        return;
      }
      console.error("[linear-mappings] Create error:", err);
      res.status(500).json({ error: "Failed to create linear mapping" });
    }
  });

  // PUT /linear-mappings/:id — update a mapping
  router.put("/:id", async (req, res) => {
    const r = req as unknown as WorkspaceAwareRequest & AuthenticatedRequest;
    const parsed = UpdateMappingBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const workspaceId = resolveWorkspaceId(r);
    const { labelName, agentId } = parsed.data;

    try {
      const { rows } = await getPool().query(
        `UPDATE linear_label_agent_mappings
         SET label_name = COALESCE($3, label_name),
             agent_id = COALESCE($4, agent_id),
             updated_at = NOW()
         WHERE id = $1 AND workspace_id = $2
         RETURNING *`,
        [req.params.id, workspaceId, labelName ?? null, agentId ?? null],
      );

      if (rows.length === 0) {
        res.status(404).json({ error: "Linear mapping not found" });
        return;
      }
      res.json(rows[0]);
    } catch (err) {
      console.error("[linear-mappings] Update error:", err);
      res.status(500).json({ error: "Failed to update linear mapping" });
    }
  });

  // DELETE /linear-mappings/:id — delete a mapping
  router.delete("/:id", async (req, res) => {
    const r = req as unknown as WorkspaceAwareRequest & AuthenticatedRequest;
    const workspaceId = resolveWorkspaceId(r);

    try {
      const { rows } = await getPool().query(
        `DELETE FROM linear_label_agent_mappings WHERE id = $1 AND workspace_id = $2 RETURNING id`,
        [req.params.id, workspaceId],
      );

      if (rows.length === 0) {
        res.status(404).json({ error: "Linear mapping not found" });
        return;
      }
      res.json({ deleted: true });
    } catch (err) {
      console.error("[linear-mappings] Delete error:", err);
      res.status(500).json({ error: "Failed to delete linear mapping" });
    }
  });

  return router;
}
