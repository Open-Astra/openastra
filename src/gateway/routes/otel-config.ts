import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { getPool } from "../../config/postgres.js";
import { jwtAuth } from "../middleware/auth.js";
import { workspaceResolver } from "../middleware/workspace.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { exportSpansToOtlp } from "../../observability/otel-exporter.js";

// ── OTLP Config Router ────────────────────────────────────────────────
// CRUD for per-workspace OTLP export config.
// All routes require JWT auth and a workspace context.

const UpsertConfigBody = z.object({
  endpoint: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
});

const ExportBody = z.object({
  sinceMs: z.number().int().min(0).optional(),
});

export function createOtelConfigRouter(): Router {
  const router = Router();
  router.use(jwtAuth(), workspaceResolver());

  // GET /otel-config — get current workspace OTLP config
  router.get("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    try {
      const pool = getPool();
      const result = await pool.query(
        `SELECT workspace_id, endpoint, headers, enabled, updated_at
         FROM otel_export_configs
         WHERE workspace_id = $1`,
        [workspaceId],
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: "No OTLP config found for this workspace" });
        return;
      }

      res.json({ config: result.rows[0] });
    } catch (err) {
      console.error("[otel-config] Get:", err);
      res.status(500).json({ error: "Failed to get OTLP config" });
    }
  });

  // PUT /otel-config — upsert OTLP config for workspace
  router.put("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = UpsertConfigBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const { endpoint, headers, enabled } = parsed.data;

    try {
      const pool = getPool();
      const result = await pool.query(
        `INSERT INTO otel_export_configs (workspace_id, endpoint, headers, enabled, updated_at)
         VALUES ($1, $2, $3::jsonb, $4, NOW())
         ON CONFLICT (workspace_id) DO UPDATE
           SET endpoint = EXCLUDED.endpoint,
               headers = EXCLUDED.headers,
               enabled = EXCLUDED.enabled,
               updated_at = NOW()
         RETURNING workspace_id, endpoint, headers, enabled, updated_at`,
        [
          workspaceId,
          endpoint,
          JSON.stringify(headers ?? {}),
          enabled ?? true,
        ],
      );

      res.json({ config: result.rows[0] });
    } catch (err) {
      console.error("[otel-config] Upsert:", err);
      res.status(500).json({ error: "Failed to save OTLP config" });
    }
  });

  // DELETE /otel-config — remove OTLP config for workspace
  router.delete("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    try {
      const pool = getPool();
      await pool.query(
        `DELETE FROM otel_export_configs WHERE workspace_id = $1`,
        [workspaceId],
      );
      res.json({ message: "OTLP config deleted" });
    } catch (err) {
      console.error("[otel-config] Delete:", err);
      res.status(500).json({ error: "Failed to delete OTLP config" });
    }
  });

  // POST /otel-config/export — trigger manual OTLP export
  router.post("/export", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = ExportBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    // Default: export spans from the last hour
    const sinceMs = parsed.data.sinceMs ?? Date.now() - 60 * 60 * 1000;

    try {
      const result = await exportSpansToOtlp(workspaceId, sinceMs);
      res.json(result);
    } catch (err) {
      console.error("[otel-config] Export:", err);
      res.status(500).json({ error: "OTLP export failed" });
    }
  });

  return router;
}
