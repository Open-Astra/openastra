// ── Role-Based Access Control Middleware ─────────────────────────────
// Enforces fine-grained capability roles on workspace routes.
// Role hierarchy: owner(4) > editor(3) > tool_runner(2) > viewer(1)
//
// Role data is stored in the `rbac_members` table (see migration 023).

import type { Request, Response, NextFunction, RequestHandler } from "express";
import { getPool } from "../../config/postgres.js";
import { createLogger } from "../../utils/logger.js";
import type { AuthenticatedRequest } from "./auth.js";
import type { WorkspaceAwareRequest } from "./workspace.js";

const logger = createLogger("rbac");

// ── Types ─────────────────────────────────────────────────────────────

export type Role = "owner" | "editor" | "tool_runner" | "viewer";

const ROLE_RANK: Record<Role, number> = {
  owner: 4,
  editor: 3,
  tool_runner: 2,
  viewer: 1,
};

// ── Role Mapping ──────────────────────────────────────────────────────
// workspace_members is the single source of truth for membership.
// WorkspaceRole values are mapped to the capability Role hierarchy so that
// requireRole() works uniformly without a second table.
//
//   workspace_members.role → Role (capability)
//   owner  → owner       (full control)
//   admin  → editor      (manage agents, settings, members)
//   member → tool_runner (run agents and tools)
//   viewer → viewer      (read-only)

const WORKSPACE_ROLE_MAP: Record<string, Role> = {
  owner:  "owner",
  admin:  "editor",
  member: "tool_runner",
  viewer: "viewer",
};

// ── Role Lookup ───────────────────────────────────────────────────────

/**
 * Fetch the capability Role for `uid` in `workspaceId` from workspace_members.
 * Returns null if the user is not a member of the workspace.
 */
export async function getWorkspaceRole(
  uid: string,
  workspaceId: string,
): Promise<Role | null> {
  const pool = getPool();
  const { rows } = await pool.query<{ role: string }>(
    "SELECT role FROM workspace_members WHERE user_id = $1 AND workspace_id = $2",
    [uid, workspaceId],
  );
  if (rows.length === 0) return null;
  return WORKSPACE_ROLE_MAP[rows[0]!.role] ?? null;
}

// ── Middleware Factory ────────────────────────────────────────────────

/**
 * Returns an Express RequestHandler that enforces a minimum RBAC role.
 *
 * - If the request has no workspace context (non-workspace routes),
 *   next() is called without any role check.
 * - If the user's role is below `minimum`, responds with 403.
 */
export function requireRole(minimum: Role): RequestHandler {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const authedReq = req as AuthenticatedRequest;
    const workspaceReq = req as WorkspaceAwareRequest;

    // Fail-closed: require workspace context when RBAC is applied
    if (!workspaceReq.workspace?.workspaceId) {
      res.status(400).json({ error: "Workspace context required for this operation" });
      return;
    }

    const uid = authedReq.uid;
    if (!uid) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    try {
      const role = await getWorkspaceRole(uid, workspaceReq.workspace.workspaceId);

      if (!role) {
        res.status(403).json({ error: "No role assigned in this workspace" });
        return;
      }

      if (ROLE_RANK[role] < ROLE_RANK[minimum]) {
        logger.warn(`uid=${uid} has role=${role}, requires ${minimum}`);
        res.status(403).json({
          error: `Insufficient permissions. Required: ${minimum}, have: ${role}`,
        });
        return;
      }

      next();
    } catch (err) {
      logger.error("RBAC role check failed:", err);
      res.status(500).json({ error: "Access control check failed" });
    }
  };
}
