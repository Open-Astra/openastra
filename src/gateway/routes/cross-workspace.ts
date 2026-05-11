import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { getPool } from "../../config/postgres.js";

const GrantBody = z.object({
  targetWorkspaceId: z.string().uuid(),
  agentId: z.string().min(1),
});

const InvokeBody = z.object({
  message: z.string().min(1),
  sessionId: z.string().uuid().optional(),
});

export function createCrossWorkspaceRouter(): Router {
  const router = Router();
  const pool = () => getPool();

  // GET /cross-workspace/grants — list grants for current workspace
  router.get("/cross-workspace/grants", async (req, res) => {
    const workspaceId = (req as WorkspaceAwareRequest).workspace.workspaceId;
    const { rows } = await pool().query(
      `SELECT id, grantor_workspace_id AS "grantorWorkspaceId",
              grantee_workspace_id AS "granteeWorkspaceId",
              agent_id AS "agentId", granted_by AS "grantedBy", created_at AS "createdAt"
       FROM cross_workspace_grants
       WHERE grantor_workspace_id = $1 OR grantee_workspace_id = $1
       ORDER BY created_at DESC`,
      [workspaceId],
    );
    res.json({ grants: rows });
  });

  // POST /cross-workspace/grants — grant another workspace access to your agent
  router.post("/cross-workspace/grants", async (req, res) => {
    const body = GrantBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: body.error.issues }); return; }

    const grantorWorkspaceId = (req as WorkspaceAwareRequest).workspace.workspaceId;
    const uid = (req as AuthenticatedRequest).uid;

    // Verify caller owns the agent in their workspace
    const { rows: agentCheck } = await pool().query(
      `SELECT id FROM agent_configs WHERE id = $1 AND workspace_id = $2`,
      [body.data.agentId, grantorWorkspaceId],
    );
    if (agentCheck.length === 0) {
      res.status(404).json({ error: "Agent not found in your workspace" });
      return;
    }

    const { rows } = await pool().query(
      `INSERT INTO cross_workspace_grants (id, grantor_workspace_id, grantee_workspace_id, agent_id, granted_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (grantor_workspace_id, grantee_workspace_id, agent_id) DO NOTHING
       RETURNING id, created_at AS "createdAt"`,
      [randomUUID(), grantorWorkspaceId, body.data.targetWorkspaceId, body.data.agentId, uid],
    );
    if (rows.length === 0) {
      res.status(409).json({ error: "Grant already exists" });
      return;
    }
    res.status(201).json(rows[0]);
  });

  // DELETE /cross-workspace/grants/:grantId — revoke a grant
  router.delete("/cross-workspace/grants/:grantId", async (req, res) => {
    const { grantId } = req.params as { grantId: string };
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    const { rowCount } = await pool().query(
      `DELETE FROM cross_workspace_grants WHERE id = $1 AND grantor_workspace_id = $2`,
      [grantId, workspaceId],
    );
    if ((rowCount ?? 0) === 0) { res.status(404).json({ error: "Grant not found" }); return; }
    res.json({ revoked: true });
  });

  // POST /workspaces/:targetWorkspaceId/agents/:agentId/invoke — invoke a foreign agent
  router.post("/workspaces/:targetWorkspaceId/agents/:agentId/invoke", async (req, res) => {
    const body = InvokeBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: body.error.issues }); return; }

    const { targetWorkspaceId, agentId } = req.params as { targetWorkspaceId: string; agentId: string };
    const callerWorkspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    const uid = (req as unknown as AuthenticatedRequest).uid;

    // Check grant
    const { rows: grants } = await pool().query(
      `SELECT id FROM cross_workspace_grants
       WHERE grantor_workspace_id = $1 AND grantee_workspace_id = $2 AND agent_id = $3`,
      [targetWorkspaceId, callerWorkspaceId, agentId],
    );
    if (grants.length === 0) {
      res.status(403).json({ error: "No grant found for this agent" });
      return;
    }

    try {
      const { getAgentConfig } = await import("../../config/agents.js");
      const { runAgentLoop } = await import("../../agents/loop.js");
      const { getInferenceClientForAgent } = await import("../../inference/factory.js");
      const agentConfig = getAgentConfig(agentId);
      const client = getInferenceClientForAgent(agentConfig);
      const result = await runAgentLoop(uid, body.data.message, agentConfig, client, {
        uid,
        surface: "chat",
        surfaceId: body.data.sessionId ?? `xws:${callerWorkspaceId}`,
      });
      res.json({ response: result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Unknown agent")) { res.status(404).json({ error: msg }); return; }
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
