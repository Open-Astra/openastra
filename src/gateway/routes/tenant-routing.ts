import { Router } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { getPool } from "../../config/postgres.js";

const RuleBody = z.object({
  provider: z.string(),
  modelId: z.string().optional(),
  region: z.string().optional(),
  endpointOverride: z.string().optional(),
  weight: z.number().default(1.0),
  priority: z.number().int().default(0),
  active: z.boolean().default(true),
});

export function createTenantRoutingRouter(): Router {
  const router = Router();

  router.get("/tenant-routing/rules", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT id, provider, model_id AS "modelId", region, endpoint_override AS "endpointOverride",
              weight, priority, active, created_at AS "createdAt"
       FROM tenant_routing_rules WHERE workspace_id = $1 ORDER BY priority DESC`,
      [workspaceId],
    );
    res.json({ rules: rows });
  });

  router.post("/tenant-routing/rules", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    const parsed = RuleBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const { provider, modelId, region, endpointOverride, weight, priority, active } = parsed.data;
    const pool = getPool();
    const { rows } = await pool.query(
      `INSERT INTO tenant_routing_rules (workspace_id, provider, model_id, region, endpoint_override, weight, priority, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [workspaceId, provider, modelId ?? null, region ?? null, endpointOverride ?? null, weight, priority, active],
    );
    res.status(201).json({ id: rows[0].id });
  });

  router.put("/tenant-routing/rules/:id", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    const parsed = RuleBody.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 3;
    for (const [k, v] of Object.entries(parsed.data)) {
      const col = k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
      fields.push(`${col} = $${idx}`);
      values.push(v);
      idx++;
    }
    if (fields.length === 0) return res.status(400).json({ error: "No fields to update" });
    fields.push(`updated_at = now()`);
    const pool = getPool();
    const { rowCount } = await pool.query(
      `UPDATE tenant_routing_rules SET ${fields.join(", ")} WHERE id = $1 AND workspace_id = $2`,
      [req.params.id, workspaceId, ...values],
    );
    if (!rowCount) return res.status(404).json({ error: "Rule not found" });
    res.json({ updated: true });
  });

  router.delete("/tenant-routing/rules/:id", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    const pool = getPool();
    const { rowCount } = await pool.query(
      `DELETE FROM tenant_routing_rules WHERE id = $1 AND workspace_id = $2`,
      [req.params.id, workspaceId],
    );
    if (!rowCount) return res.status(404).json({ error: "Rule not found" });
    res.json({ deleted: true });
  });

  router.get("/tenant-routing/resolve", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT provider, model_id AS "modelId", region, endpoint_override AS "endpointOverride", weight
       FROM tenant_routing_rules
       WHERE workspace_id = $1 AND active = true
       ORDER BY priority DESC, weight DESC`,
      [workspaceId],
    );
    res.json({ resolved: rows });
  });

  return router;
}
