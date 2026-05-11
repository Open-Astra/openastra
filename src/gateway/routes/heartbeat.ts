import { Router } from "express";
import { z } from "zod";
import { getPool } from "../../config/postgres.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { isBlockedUrl } from "../../utils/ssrf-guard.js";

const HeartbeatCreateBody = z.object({
  name: z.string().min(1).max(200),
  agentId: z.string().min(1).default("default"),
  type: z.enum(["rss", "http", "github"]),
  url: z.string().url().optional(),
  config: z.record(z.string(), z.unknown()).default({}),
  intervalMinutes: z.number().int().min(5).max(10080).default(30), // 5 min floor, 1 week max
  prompt: z.string().max(2000).optional(),
});

// ── Heartbeat Router ─────────────────────────────────────────────────

export function createHeartbeatRouter(): Router {
  const router = Router();

  // GET /heartbeat — list configs with their last run
  router.get("/", async (req, res) => {
    try {
      const uid = (req as AuthenticatedRequest).uid;
      const wsReq = req as WorkspaceAwareRequest;
      const workspaceId = wsReq.workspace?.workspaceId ?? null;

      const pool = getPool();
      const { rows } = await pool.query(
        `SELECT c.*,
                r.status      AS last_status,
                r.agent_summary AS last_summary,
                r.duration_ms AS last_duration_ms,
                r.created_at  AS last_run_created_at
         FROM heartbeat_configs c
         LEFT JOIN LATERAL (
           SELECT status, agent_summary, duration_ms, created_at
           FROM heartbeat_runs
           WHERE config_id = c.id
           ORDER BY created_at DESC
           LIMIT 1
         ) r ON true
         WHERE (c.uid = $1 OR $2::uuid IS NOT NULL AND c.workspace_id = $2)
         ORDER BY c.created_at DESC`,
        [uid, workspaceId],
      );

      res.json({ configs: rows });
    } catch (err) {
      console.error("[heartbeat] list error:", err);
      res.status(500).json({ error: "Failed to list heartbeat configs" });
    }
  });

  // POST /heartbeat — create a new config
  router.post("/", async (req, res) => {
    const parsed = HeartbeatCreateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const { name, agentId, type, url, config: extraConfig, intervalMinutes, prompt } = parsed.data;

    if (url && await isBlockedUrl(url)) {
      res.status(400).json({ error: "URL targets a blocked internal address" });
      return;
    }

    try {
      const uid = (req as AuthenticatedRequest).uid;
      const wsReq = req as WorkspaceAwareRequest;
      const workspaceId = wsReq.workspace?.workspaceId ?? null;

      const pool = getPool();
      const { rows } = await pool.query(
        `INSERT INTO heartbeat_configs
           (name, uid, workspace_id, agent_id, type, url, config, interval_minutes, prompt)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [name, uid, workspaceId, agentId, type, url ?? null, JSON.stringify(extraConfig), intervalMinutes, prompt ?? null],
      );

      res.status(201).json({ config: rows[0] });
    } catch (err) {
      console.error("[heartbeat] create error:", err);
      res.status(500).json({ error: "Failed to create heartbeat config" });
    }
  });

  // GET /heartbeat/:id/runs — paginated run history
  router.get("/:id/runs", async (req, res) => {
    try {
      const uid = (req as unknown as AuthenticatedRequest).uid;
      const { id } = req.params as { id: string };
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const offset = parseInt(req.query.offset as string) || 0;

      const pool = getPool();

      // Verify ownership
      const { rows: cfg } = await pool.query(
        `SELECT id FROM heartbeat_configs WHERE id = $1 AND uid = $2 LIMIT 1`,
        [id, uid],
      );
      if (cfg.length === 0) {
        res.status(404).json({ error: "Config not found" });
        return;
      }

      const { rows } = await pool.query(
        `SELECT * FROM heartbeat_runs
         WHERE config_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [id, limit, offset],
      );

      res.json({ runs: rows, limit, offset });
    } catch (err) {
      console.error("[heartbeat] runs error:", err);
      res.status(500).json({ error: "Failed to fetch runs" });
    }
  });

  // PATCH /heartbeat/:id — enable/disable
  router.patch("/:id", async (req, res) => {
    const patchParsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!patchParsed.success) {
      res.status(400).json({ error: "enabled (boolean) is required" });
      return;
    }

    try {
      const uid = (req as unknown as AuthenticatedRequest).uid;
      const wsReq = req as WorkspaceAwareRequest;
      const workspaceId = wsReq.workspace?.workspaceId ?? null;
      const { id } = req.params as { id: string };
      const { enabled } = patchParsed.data;

      const pool = getPool();
      const { rows } = await pool.query(
        `UPDATE heartbeat_configs SET enabled = $1
         WHERE id = $2 AND (uid = $3 OR ($4::uuid IS NOT NULL AND workspace_id = $4))
         RETURNING *`,
        [enabled, id, uid, workspaceId],
      );

      if (rows.length === 0) {
        res.status(404).json({ error: "Config not found" });
        return;
      }

      res.json({ config: rows[0] });
    } catch (err) {
      console.error("[heartbeat] patch error:", err);
      res.status(500).json({ error: "Failed to update heartbeat config" });
    }
  });

  // DELETE /heartbeat/:id — delete config
  router.delete("/:id", async (req, res) => {
    try {
      const uid = (req as unknown as AuthenticatedRequest).uid;
      const wsReq = req as WorkspaceAwareRequest;
      const workspaceId = wsReq.workspace?.workspaceId ?? null;
      const { id } = req.params as { id: string };

      const pool = getPool();
      const { rows } = await pool.query(
        `DELETE FROM heartbeat_configs
         WHERE id = $1 AND (uid = $2 OR ($3::uuid IS NOT NULL AND workspace_id = $3))
         RETURNING id`,
        [id, uid, workspaceId],
      );

      if (rows.length === 0) {
        res.status(404).json({ error: "Config not found" });
        return;
      }

      res.json({ deleted: true });
    } catch (err) {
      console.error("[heartbeat] delete error:", err);
      res.status(500).json({ error: "Failed to delete heartbeat config" });
    }
  });

  return router;
}
