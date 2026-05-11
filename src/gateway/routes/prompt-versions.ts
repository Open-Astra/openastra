import { Router } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { getPool } from "../../config/postgres.js";
import { randomUUID } from "node:crypto";

const SaveVersionBody = z.object({
  systemPrompt: z.string().min(1),
  label: z.string().max(200).optional(),
});

export function createPromptVersionsRouter(): Router {
  const router = Router();
  const pool = () => getPool();

  // GET /agents/:agentId/prompt-versions
  router.get("/agents/:agentId/prompt-versions", async (req, res) => {
    const { agentId } = req.params as { agentId: string };
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    const { rows } = await pool().query(
      `SELECT id, agent_id AS "agentId", workspace_id AS "workspaceId", version, label,
              system_prompt AS "systemPrompt", created_by AS "createdBy", created_at AS "createdAt"
       FROM agent_prompt_versions
       WHERE agent_id = $1 AND workspace_id = $2
       ORDER BY version DESC`,
      [agentId, workspaceId],
    );
    res.json({ versions: rows });
  });

  // POST /agents/:agentId/prompt-versions — save a new version
  router.post("/agents/:agentId/prompt-versions", async (req, res) => {
    const body = SaveVersionBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: body.error.issues }); return; }

    const { agentId } = req.params as { agentId: string };
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    const uid = (req as unknown as AuthenticatedRequest).uid;

    const { rows: maxRows } = await pool().query<{ max: number | null }>(
      `SELECT MAX(version) AS max FROM agent_prompt_versions WHERE agent_id = $1 AND workspace_id = $2`,
      [agentId, workspaceId],
    );
    const nextVersion = (maxRows[0]?.max ?? 0) + 1;

    const { rows } = await pool().query(
      `INSERT INTO agent_prompt_versions (id, agent_id, workspace_id, version, system_prompt, label, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, version, label, created_at AS "createdAt"`,
      [randomUUID(), agentId, workspaceId, nextVersion, body.data.systemPrompt, body.data.label ?? null, uid],
    );
    res.status(201).json(rows[0]);
  });

  // GET /agents/:agentId/prompt-versions/:version
  router.get("/agents/:agentId/prompt-versions/:version", async (req, res) => {
    const { agentId, version } = req.params as { agentId: string; version: string };
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    const { rows } = await pool().query(
      `SELECT id, version, system_prompt AS "systemPrompt", label, created_at AS "createdAt"
       FROM agent_prompt_versions WHERE agent_id = $1 AND workspace_id = $2 AND version = $3`,
      [agentId, workspaceId, parseInt(version, 10)],
    );
    if (rows.length === 0) { res.status(404).json({ error: "Version not found" }); return; }
    res.json(rows[0]);
  });

  // POST /agents/:agentId/prompt-versions/:version/restore
  router.post("/agents/:agentId/prompt-versions/:version/restore", async (req, res) => {
    const { agentId, version } = req.params as { agentId: string; version: string };
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;

    const { rows } = await pool().query<{ system_prompt: string }>(
      `SELECT system_prompt FROM agent_prompt_versions WHERE agent_id = $1 AND workspace_id = $2 AND version = $3`,
      [agentId, workspaceId, parseInt(version, 10)],
    );
    if (rows.length === 0) { res.status(404).json({ error: "Version not found" }); return; }

    await pool().query(
      `UPDATE agent_configs SET config = jsonb_set(config, '{systemPromptTemplate}', $1::jsonb), updated_at = NOW()
       WHERE id = $2 AND workspace_id = $3`,
      [JSON.stringify(rows[0]!.system_prompt), agentId, workspaceId],
    );
    res.json({ restored: true, version: parseInt(version, 10) });
  });

  return router;
}
