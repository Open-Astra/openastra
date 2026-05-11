import { Router } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import {
  createWorkspace,
  getWorkspace,
  listUserWorkspaces,
  updateWorkspaceSettings,
  addMember,
  removeMember,
  getMemberRole,
} from "../../workspaces/store.js";
import { getPool } from "../../config/postgres.js";
import { WorkspacePlan, WorkspaceRole } from "../../workspaces/types.js";

// ── Request Validation ──────────────────────────────────────────────

const CreateWorkspaceBody = z.object({
  name: z.string().min(1).max(100),
  plan: WorkspacePlan.default("team"),
});

const UpdateSettingsBody = z.object({
  defaultAgentId: z.string().optional(),
  customAgentConfigs: z.record(z.string(), z.unknown()).optional(),
});

const AddMemberBody = z.object({
  uid: z.string().min(1),
  role: WorkspaceRole.default("member"),
});

// ── Workspace Router ────────────────────────────────────────────────

export function createWorkspaceRouter(): Router {
  const router = Router();

  // POST /workspaces — Create a new workspace
  router.post("/", async (req, res) => {
    const { uid } = req as unknown as AuthenticatedRequest;

    const parsed = CreateWorkspaceBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    try {
      const workspace = await createWorkspace(
        uid,
        parsed.data.name,
        parsed.data.plan,
      );
      res.status(201).json(workspace);
    } catch (err) {
      console.error("[workspaces] Create failed:", err);
      res.status(500).json({ error: "Failed to create workspace" });
    }
  });

  // GET /workspaces — List user's workspaces
  router.get("/", async (req, res) => {
    const { uid } = req as unknown as AuthenticatedRequest;

    try {
      const workspaces = await listUserWorkspaces(uid);
      res.json({ workspaces });
    } catch (err) {
      console.error("[workspaces] List failed:", err);
      res.status(500).json({ error: "Failed to list workspaces" });
    }
  });

  // GET /workspaces/:id — Get workspace detail
  router.get("/:id", async (req, res) => {
    const { uid } = req as unknown as AuthenticatedRequest;
    const { id } = req.params;

    try {
      // Verify membership
      const role = await getMemberRole(id, uid);
      if (!role) {
        res.status(403).json({ error: "Not a member of this workspace" });
        return;
      }

      const workspace = await getWorkspace(id);
      if (!workspace) {
        res.status(404).json({ error: "Workspace not found" });
        return;
      }

      res.json({ ...workspace, yourRole: role });
    } catch (err) {
      console.error("[workspaces] Get failed:", err);
      res.status(500).json({ error: "Failed to get workspace" });
    }
  });

  // PUT /workspaces/:id/settings — Update workspace settings
  router.put("/:id/settings", async (req, res) => {
    const { uid } = req as unknown as AuthenticatedRequest;
    const { id } = req.params;

    const parsed = UpdateSettingsBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    try {
      // Verify admin+ role
      const role = await getMemberRole(id, uid);
      if (!role || !["owner", "admin"].includes(role)) {
        res
          .status(403)
          .json({ error: "Requires owner or admin role" });
        return;
      }

      await updateWorkspaceSettings(id, parsed.data);
      res.json({ message: "Settings updated" });
    } catch (err) {
      console.error("[workspaces] Settings update failed:", err);
      res.status(500).json({ error: "Failed to update settings" });
    }
  });

  // POST /workspaces/:id/members — Invite member
  router.post("/:id/members", async (req, res) => {
    const { uid } = req as unknown as AuthenticatedRequest;
    const { id } = req.params;

    const parsed = AddMemberBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    try {
      // Verify admin+ role
      const role = await getMemberRole(id, uid);
      if (!role || !["owner", "admin"].includes(role)) {
        res
          .status(403)
          .json({ error: "Requires owner or admin role" });
        return;
      }

      // Role-ceiling enforcement: prevent granting roles at or above caller's level
      const requestedRole = parsed.data.role;
      if (role === "admin" && (requestedRole === "owner" || requestedRole === "admin")) {
        res.status(403).json({ error: "Admins can only assign member or viewer roles" });
        return;
      }

      // Prevent self-role-elevation
      if (parsed.data.uid === uid) {
        res.status(403).json({ error: "Cannot modify your own role" });
        return;
      }

      await addMember(id, parsed.data.uid, parsed.data.role, uid);
      res.status(201).json({ message: "Member added" });
    } catch (err) {
      console.error("[workspaces] Add member failed:", err);
      res.status(500).json({ error: "Failed to add member" });
    }
  });

  // DELETE /workspaces/:id/members/:uid — Remove member
  router.delete("/:id/members/:uid", async (req, res) => {
    const { uid } = req as unknown as AuthenticatedRequest;
    const { id } = req.params;
    const targetUid = req.params.uid;

    try {
      // Verify admin+ role (or self-removal)
      const role = await getMemberRole(id, uid);
      if (!role) {
        res.status(403).json({ error: "Not a member of this workspace" });
        return;
      }

      const isSelfRemoval = uid === targetUid;
      if (!isSelfRemoval && !["owner", "admin"].includes(role)) {
        res
          .status(403)
          .json({ error: "Requires owner or admin role" });
        return;
      }

      // Prevent owner from removing themselves
      if (isSelfRemoval && role === "owner") {
        res
          .status(400)
          .json({ error: "Owner cannot remove themselves. Transfer ownership first." });
        return;
      }

      await removeMember(id, targetUid);
      res.json({ message: "Member removed" });
    } catch (err) {
      console.error("[workspaces] Remove member failed:", err);
      res.status(500).json({ error: "Failed to remove member" });
    }
  });

  // GET /workspaces/:id/stats — usage dashboard (rec 23)
  // Session count, token/cost totals, top agents, top tools, active users
  // for a configurable time window (default: last 30 days).
  router.get("/:id/stats", async (req, res) => {
    const { uid } = req as unknown as AuthenticatedRequest;
    const { id } = req.params;
    const rawDays = parseInt(req.query.days as string, 10);
    const days = Math.min(Number.isNaN(rawDays) ? 30 : rawDays, 365);

    try {
      const role = await getMemberRole(id, uid);
      if (!role) {
        res.status(403).json({ error: "Not a member of this workspace" });
        return;
      }

      const pool = getPool();

      const [sessions, tokens, topAgents, topTools, activeUsers] = await Promise.all([
        // Total sessions
        pool.query<{ count: string; active: string }>(
          `SELECT COUNT(*) AS count,
                  COUNT(*) FILTER (WHERE status = 'active') AS active
           FROM sessions WHERE workspace_id = $1 AND created_at > NOW() - INTERVAL '1 day' * $2`,
          [id, days],
        ),

        // Token + cost totals
        pool.query<{ total_tokens: string; total_cost: string }>(
          `SELECT COALESCE(SUM(total_tokens), 0) AS total_tokens,
                  COALESCE(SUM(cost_usd), 0)     AS total_cost
           FROM billing_usage WHERE workspace_id = $1 AND recorded_at > NOW() - INTERVAL '1 day' * $2`,
          [id, days],
        ),

        // Top 5 agents by session count
        pool.query<{ agent_id: string; session_count: string }>(
          `SELECT agent_id, COUNT(*) AS session_count
           FROM sessions WHERE workspace_id = $1 AND created_at > NOW() - INTERVAL '1 day' * $2
           GROUP BY agent_id ORDER BY session_count DESC LIMIT 5`,
          [id, days],
        ),

        // Top 5 tools by call count
        pool.query<{ tool_name: string; call_count: string }>(
          `SELECT tool_name, COUNT(*) AS call_count
           FROM tool_outputs to2
           JOIN sessions s ON s.id = to2.session_id
           WHERE s.workspace_id = $1 AND to2.created_at > NOW() - INTERVAL '1 day' * $2
           GROUP BY tool_name ORDER BY call_count DESC LIMIT 5`,
          [id, days],
        ),

        // Active unique users
        pool.query<{ count: string }>(
          `SELECT COUNT(DISTINCT user_id) AS count
           FROM sessions WHERE workspace_id = $1 AND last_active_at > NOW() - INTERVAL '1 day' * $2`,
          [id, days],
        ),
      ]);

      res.json({
        workspaceId: id,
        windowDays: days,
        sessions: {
          total: parseInt(sessions.rows[0]?.count ?? "0", 10),
          active: parseInt(sessions.rows[0]?.active ?? "0", 10),
        },
        usage: {
          totalTokens: parseInt(tokens.rows[0]?.total_tokens ?? "0", 10),
          totalCostUsd: parseFloat(tokens.rows[0]?.total_cost ?? "0"),
        },
        topAgents: topAgents.rows.map((r) => ({
          agentId: r.agent_id,
          sessionCount: parseInt(r.session_count, 10),
        })),
        topTools: topTools.rows.map((r) => ({
          toolName: r.tool_name,
          callCount: parseInt(r.call_count, 10),
        })),
        activeUsers: parseInt(activeUsers.rows[0]?.count ?? "0", 10),
      });
    } catch (err) {
      console.error("[workspaces] Stats error:", err);
      res.status(500).json({ error: "Failed to get workspace stats" });
    }
  });

  // POST /workspaces/:id/grants — grant another workspace access to an agent (rec 24)
  router.post("/:id/grants", async (req, res) => {
    const { uid } = req as unknown as AuthenticatedRequest;
    const { id } = req.params;

    const parsed = z.object({
      receivingWorkspaceId: z.string().min(1),
      agentId: z.string().min(1),
      readonly: z.boolean().default(true),
      expiresAt: z.string().datetime().optional(),
    }).safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    try {
      const role = await getMemberRole(id, uid);
      if (!role || !["owner", "admin"].includes(role)) {
        res.status(403).json({ error: "Requires owner or admin role" });
        return;
      }

      const pool = getPool();

      // Verify the agent is owned by the granting workspace before issuing a grant.
      // Without this check any workspace owner could grant agents they don't own.
      const { rows: agentRows } = await pool.query<{ id: string }>(
        "SELECT id FROM agent_configs WHERE id = $1 AND workspace_id = $2",
        [parsed.data.agentId, id],
      );
      if (agentRows.length === 0) {
        res.status(403).json({ error: `Agent "${parsed.data.agentId}" is not owned by this workspace` });
        return;
      }

      await pool.query(
        `INSERT INTO workspace_agent_grants
           (granting_workspace_id, receiving_workspace_id, agent_id, readonly, granted_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (granting_workspace_id, receiving_workspace_id, agent_id)
         DO UPDATE SET readonly = $4, expires_at = $6, granted_by = $5`,
        [id, parsed.data.receivingWorkspaceId, parsed.data.agentId, parsed.data.readonly, uid, parsed.data.expiresAt ?? null],
      );

      res.status(201).json({ message: "Grant created" });
    } catch (err) {
      console.error("[workspaces] Grant error:", err);
      res.status(500).json({ error: "Failed to create grant" });
    }
  });

  // DELETE /workspaces/:id/grants — revoke a cross-workspace agent grant (rec 24)
  router.delete("/:id/grants", async (req, res) => {
    const { uid } = req as unknown as AuthenticatedRequest;
    const { id } = req.params;

    const parsed = z.object({
      receivingWorkspaceId: z.string().min(1),
      agentId: z.string().min(1),
    }).safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    try {
      const role = await getMemberRole(id, uid);
      if (!role || !["owner", "admin"].includes(role)) {
        res.status(403).json({ error: "Requires owner or admin role" });
        return;
      }

      const pool = getPool();
      await pool.query(
        `DELETE FROM workspace_agent_grants
         WHERE granting_workspace_id = $1
           AND receiving_workspace_id = $2
           AND agent_id = $3`,
        [id, parsed.data.receivingWorkspaceId, parsed.data.agentId],
      );

      res.json({ message: "Grant revoked" });
    } catch (err) {
      console.error("[workspaces] Revoke grant error:", err);
      res.status(500).json({ error: "Failed to revoke grant" });
    }
  });

  // PUT /workspaces/:id/restrictions — set model restrictions (rec 21)
  router.put("/:id/restrictions", async (req, res) => {
    const { uid } = req as unknown as AuthenticatedRequest;
    const { id } = req.params;

    const parsed = z.object({
      allowedProviders: z.array(z.string()).nullable().optional(),
      allowedModels: z.array(z.string()).nullable().optional(),
    }).safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    try {
      const role = await getMemberRole(id, uid);
      if (!role || !["owner", "admin"].includes(role)) {
        res.status(403).json({ error: "Requires owner or admin role" });
        return;
      }

      const pool = getPool();
      await pool.query(
        `UPDATE workspaces
         SET allowed_providers = $2::jsonb,
             allowed_models    = $3::jsonb
         WHERE id = $1`,
        [
          id,
          parsed.data.allowedProviders !== undefined ? JSON.stringify(parsed.data.allowedProviders) : null,
          parsed.data.allowedModels !== undefined ? JSON.stringify(parsed.data.allowedModels) : null,
        ],
      );

      res.json({ message: "Model restrictions updated" });
    } catch (err) {
      console.error("[workspaces] Restrictions update error:", err);
      res.status(500).json({ error: "Failed to update restrictions" });
    }
  });

  return router;
}
