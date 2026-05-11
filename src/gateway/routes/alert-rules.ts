import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { getPool } from "../../config/postgres.js";
import { evaluateAlertRules, dispatchAlertFirings } from "../../observability/alert-rules.js";

const CreateBody = z.object({
  name: z.string().min(1).max(200),
  metric: z.enum(["cost_usd", "error_rate", "latency_p99_ms", "token_count"]),
  operator: z.enum(["gt", "lt", "gte", "lte"]),
  threshold: z.number(),
  windowMinutes: z.number().int().positive().default(60),
  webhookUrl: z.string().url().optional(),
  emailTo: z.array(z.string().email()).optional(),
  enabled: z.boolean().default(true),
});

const UpdateBody = z.object({
  threshold: z.number().optional(),
  enabled: z.boolean().optional(),
  webhookUrl: z.string().url().nullable().optional(),
  windowMinutes: z.number().int().positive().optional(),
});

export function createAlertRulesRouter(): Router {
  const router = Router();
  const pool = () => getPool();

  router.get("/alert-rules", async (req, res) => {
    const workspaceId = (req as WorkspaceAwareRequest).workspace.workspaceId;
    const { rows } = await pool().query(
      `SELECT id, name, metric, operator, threshold, window_minutes AS "windowMinutes",
              webhook_url AS "webhookUrl", email_to AS "emailTo", enabled,
              last_fired_at AS "lastFiredAt", created_at AS "createdAt"
       FROM alert_rules WHERE workspace_id = $1 ORDER BY created_at DESC`,
      [workspaceId],
    );
    res.json({ rules: rows });
  });

  router.post("/alert-rules", async (req, res) => {
    const body = CreateBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: body.error.issues }); return; }
    const workspaceId = (req as WorkspaceAwareRequest).workspace.workspaceId;
    const { rows } = await pool().query(
      `INSERT INTO alert_rules (id, workspace_id, name, metric, operator, threshold, window_minutes, webhook_url, email_to, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, created_at AS "createdAt"`,
      [randomUUID(), workspaceId, body.data.name, body.data.metric, body.data.operator,
       body.data.threshold, body.data.windowMinutes, body.data.webhookUrl ?? null,
       body.data.emailTo ?? null, body.data.enabled],
    );
    res.status(201).json(rows[0]);
  });

  router.patch("/alert-rules/:id", async (req, res) => {
    const body = UpdateBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: body.error.issues }); return; }
    const { id } = req.params as { id: string };
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;

    const sets: string[] = ["updated_at = NOW()"];
    const params: unknown[] = [id, workspaceId];
    let i = 3;
    if (body.data.threshold !== undefined) { sets.push(`threshold = $${i++}`); params.push(body.data.threshold); }
    if (body.data.enabled !== undefined) { sets.push(`enabled = $${i++}`); params.push(body.data.enabled); }
    if (body.data.webhookUrl !== undefined) { sets.push(`webhook_url = $${i++}`); params.push(body.data.webhookUrl); }
    if (body.data.windowMinutes !== undefined) { sets.push(`window_minutes = $${i++}`); params.push(body.data.windowMinutes); }

    const { rowCount } = await pool().query(
      `UPDATE alert_rules SET ${sets.join(", ")} WHERE id = $1 AND workspace_id = $2`,
      params,
    );
    if ((rowCount ?? 0) === 0) { res.status(404).json({ error: "Alert rule not found" }); return; }
    res.json({ updated: true });
  });

  router.delete("/alert-rules/:id", async (req, res) => {
    const { id } = req.params as { id: string };
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    const { rowCount } = await pool().query(
      `DELETE FROM alert_rules WHERE id = $1 AND workspace_id = $2`, [id, workspaceId],
    );
    if ((rowCount ?? 0) === 0) { res.status(404).json({ error: "Alert rule not found" }); return; }
    res.json({ deleted: true });
  });

  router.get("/alert-rules/evaluate", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    const firings = await evaluateAlertRules(workspaceId);
    if (firings.length > 0) {
      dispatchAlertFirings(firings).catch(() => {});
    }
    res.json({ firings, count: firings.length });
  });

  return router;
}
