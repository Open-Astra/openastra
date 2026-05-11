import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { getPool } from "../../config/postgres.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";

// ── SLO Router ───────────────────────────────────────────────────────
// CRUD for Service Level Objective definitions and violation status.
//   GET    /slos         — list SLO definitions for workspace
//   POST   /slos         — create SLO
//   PUT    /slos/:id     — update SLO definition
//   DELETE /slos/:id     — delete SLO
//   GET    /slos/:id/status — latest violation count + most recent measured value

const SloMetric = z.enum(["p95_latency_ms", "error_rate_pct"]);

const CreateSloBody = z.object({
  agentId: z.string().min(1).max(128),
  metric: SloMetric,
  threshold: z.number().positive(),
  windowMinutes: z.number().int().min(1).max(10080).optional(),
  alertWebhookUrl: z.string().url().optional(),
});

const UpdateSloBody = z.object({
  threshold: z.number().positive().optional(),
  windowMinutes: z.number().int().min(1).max(10080).optional(),
  alertWebhookUrl: z.string().url().nullable().optional(),
});

export function createSlosRouter(): Router {
  const router = Router();

  // GET /slos — list all SLO definitions for the workspace
  router.get("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.json({ slos: [] });
      return;
    }

    try {
      const pool = getPool();
      const result = await pool.query(
        `SELECT id, agent_id, metric, threshold, window_minutes, alert_webhook_url, created_at
         FROM slo_definitions
         WHERE workspace_id = $1
         ORDER BY created_at DESC`,
        [workspaceId],
      );
      res.json({ slos: result.rows });
    } catch (err) {
      console.error("[slos] List:", err);
      res.status(500).json({ error: "Failed to list SLOs" });
    }
  });

  // POST /slos — create a new SLO definition
  router.post("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = CreateSloBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const { agentId, metric, threshold, windowMinutes, alertWebhookUrl } = parsed.data;

    try {
      const pool = getPool();
      const result = await pool.query<{ id: string }>(
        `INSERT INTO slo_definitions (workspace_id, agent_id, metric, threshold, window_minutes, alert_webhook_url)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [workspaceId, agentId, metric, threshold, windowMinutes ?? 60, alertWebhookUrl ?? null],
      );
      res.status(201).json({ id: result.rows[0]?.id });
    } catch (err) {
      console.error("[slos] Create:", err);
      res.status(500).json({ error: "Failed to create SLO" });
    }
  });

  // PUT /slos/:id — update SLO definition
  router.put("/:id", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = UpdateSloBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const { threshold, windowMinutes, alertWebhookUrl } = parsed.data;
    const { id } = req.params as { id: string };

    // Build dynamic SET clause
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    if (threshold !== undefined) {
      setClauses.push(`threshold = $${paramIdx++}`);
      values.push(threshold);
    }
    if (windowMinutes !== undefined) {
      setClauses.push(`window_minutes = $${paramIdx++}`);
      values.push(windowMinutes);
    }
    if (alertWebhookUrl !== undefined) {
      setClauses.push(`alert_webhook_url = $${paramIdx++}`);
      values.push(alertWebhookUrl);
    }

    if (setClauses.length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    values.push(id, workspaceId);

    try {
      const pool = getPool();
      const result = await pool.query(
        `UPDATE slo_definitions SET ${setClauses.join(", ")}
         WHERE id = $${paramIdx} AND workspace_id = $${paramIdx + 1}`,
        values,
      );
      if ((result.rowCount ?? 0) === 0) {
        res.status(404).json({ error: "SLO not found" });
        return;
      }
      res.json({ message: "SLO updated" });
    } catch (err) {
      console.error("[slos] Update:", err);
      res.status(500).json({ error: "Failed to update SLO" });
    }
  });

  // DELETE /slos/:id — delete SLO
  router.delete("/:id", async (req: Request, res: Response) => {
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
        `DELETE FROM slo_definitions WHERE id = $1 AND workspace_id = $2`,
        [id, workspaceId],
      );
      if ((result.rowCount ?? 0) === 0) {
        res.status(404).json({ error: "SLO not found" });
        return;
      }
      res.json({ message: "SLO deleted" });
    } catch (err) {
      console.error("[slos] Delete:", err);
      res.status(500).json({ error: "Failed to delete SLO" });
    }
  });

  // GET /slos/:id/status — latest violation count + most recent measured value
  router.get("/:id/status", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const { id } = req.params as { id: string };

    try {
      const pool = getPool();

      // Verify ownership
      const sloResult = await pool.query<{
        id: string; metric: string; threshold: number; window_minutes: number;
      }>(
        `SELECT id, metric, threshold, window_minutes FROM slo_definitions
         WHERE id = $1 AND workspace_id = $2`,
        [id, workspaceId],
      );
      if (sloResult.rows.length === 0) {
        res.status(404).json({ error: "SLO not found" });
        return;
      }

      const violationResult = await pool.query<{
        violation_count: string;
        latest_measured: number | null;
        latest_violated_at: string | null;
      }>(
        `SELECT COUNT(*) as violation_count,
                MAX(measured_value) as latest_measured,
                MAX(violated_at) as latest_violated_at
         FROM slo_violations
         WHERE slo_id = $1`,
        [id],
      );

      const row = violationResult.rows[0];
      res.json({
        sloId: id,
        violationCount: Number(row?.violation_count ?? 0),
        latestMeasuredValue: row?.latest_measured ?? null,
        latestViolatedAt: row?.latest_violated_at ?? null,
        slo: sloResult.rows[0],
      });
    } catch (err) {
      console.error("[slos] Status:", err);
      res.status(500).json({ error: "Failed to get SLO status" });
    }
  });

  return router;
}
