import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { getPool } from "../../config/postgres.js";
import { syncKnowledgeSource } from "../../memory/kb-sync.js";

const CreateSourceBody = z.object({
  type: z.enum(["notion", "confluence", "github_wiki", "url"]),
  config: z.record(z.string(), z.unknown()).default({}),
});

const UpdateSourceBody = z.object({
  config: z.record(z.string(), z.unknown()),
  type: z.enum(["notion", "confluence", "github_wiki", "url"]).optional(),
});

export function createKbSyncRouter(): Router {
  const router = Router();

  // GET / — list knowledge sync sources for workspace
  router.get("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.json({ sources: [] });
      return;
    }

    try {
      const pool = getPool();
      const result = await pool.query(
        `SELECT id, type, config, last_synced_at, status, created_at, updated_at
         FROM knowledge_sync_sources
         WHERE workspace_id = $1
         ORDER BY created_at DESC`,
        [workspaceId],
      );
      res.json({ sources: result.rows });
    } catch (err) {
      console.error("[kb-sync] List:", err);
      res.status(500).json({ error: "Failed to list knowledge sources" });
    }
  });

  // POST / — create a new knowledge sync source
  router.post("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = CreateSourceBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    try {
      const pool = getPool();
      const result = await pool.query(
        `INSERT INTO knowledge_sync_sources (workspace_id, type, config)
         VALUES ($1, $2, $3::jsonb)
         RETURNING id, type, config, status, created_at`,
        [workspaceId, parsed.data.type, JSON.stringify(parsed.data.config)],
      );
      res.status(201).json({ source: result.rows[0] });
    } catch (err) {
      console.error("[kb-sync] Create:", err);
      res.status(500).json({ error: "Failed to create knowledge source" });
    }
  });

  // PUT /:id — update source config
  router.put("/:id", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = UpdateSourceBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    try {
      const pool = getPool();
      const result = await pool.query(
        `UPDATE knowledge_sync_sources
         SET config = $3::jsonb,
             type = COALESCE($4, type),
             updated_at = NOW()
         WHERE id = $1 AND workspace_id = $2
         RETURNING id, type, config, status, updated_at`,
        [req.params.id, workspaceId, JSON.stringify(parsed.data.config), parsed.data.type ?? null],
      );
      if (result.rowCount === 0) {
        res.status(404).json({ error: "Source not found" });
        return;
      }
      res.json({ source: result.rows[0] });
    } catch (err) {
      console.error("[kb-sync] Update:", err);
      res.status(500).json({ error: "Failed to update knowledge source" });
    }
  });

  // DELETE /:id — delete source
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
        `DELETE FROM knowledge_sync_sources WHERE id = $1 AND workspace_id = $2`,
        [req.params.id, workspaceId],
      );
      if (result.rowCount === 0) {
        res.status(404).json({ error: "Source not found" });
        return;
      }
      res.json({ message: "Source deleted" });
    } catch (err) {
      console.error("[kb-sync] Delete:", err);
      res.status(500).json({ error: "Failed to delete knowledge source" });
    }
  });

  // POST /:id/sync — trigger sync
  router.post("/:id/sync", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    try {
      const result = await syncKnowledgeSource(req.params.id as string, workspaceId);
      res.json({ result });
    } catch (err) {
      console.error("[kb-sync] Sync:", err);
      const msg = err instanceof Error ? err.message : "Failed to sync";
      if (msg.includes("not found")) {
        res.status(404).json({ error: msg });
      } else {
        res.status(500).json({ error: msg });
      }
    }
  });

  return router;
}
