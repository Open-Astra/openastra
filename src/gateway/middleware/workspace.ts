import type { Request, Response, NextFunction } from "express";
import type { BudgetAwareRequest } from "./token-budget.js";
import { getMemberRole } from "../../workspaces/store.js";
import type { WorkspaceContext } from "../../workspaces/types.js";
import { checkIpAllowlist } from "../../security/ip-allowlist.js";

// ── Workspace-Aware Request ─────────────────────────────────────────

export interface WorkspaceAwareRequest extends BudgetAwareRequest {
  workspace: WorkspaceContext;
}

// ── Workspace Resolver Middleware ────────────────────────────────────
// Reads X-Workspace-Id header to determine workspace context.
// If no header → personal scope (workspaceId: null, role: "owner").
//   "owner" here means owner of the caller's OWN personal data only.
//   Handlers and stores must treat a null workspaceId as "rows with no
//   workspace that belong to this uid / global rows" — never as "skip the
//   workspace filter". Anything that mutates workspace-owned resources
//   must call requireWorkspace()/requireRole(), which reject a null id.
// If header present → validates membership and attaches context, and
//   read-only viewers are refused state-changing methods.

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const WORKSPACE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Reject requests that carry no workspace (personal scope). */
export function requireWorkspace() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!(req as WorkspaceAwareRequest).workspace?.workspaceId) {
      res.status(400).json({ error: "Workspace context required (X-Workspace-Id)" });
      return;
    }
    next();
  };
}

export function workspaceResolver() {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const uid = (req as BudgetAwareRequest).uid;
    const rawHeader = req.headers["x-workspace-id"];
    const workspaceId = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

    if (workspaceId !== undefined && workspaceId !== "" && !WORKSPACE_ID_RE.test(workspaceId)) {
      res.status(400).json({ error: "Invalid X-Workspace-Id" });
      return;
    }

    if (!workspaceId) {
      (req as WorkspaceAwareRequest).workspace = {
        workspaceId: null,
        role: "owner",
      };
      next();
      return;
    }

    try {
      const role = await getMemberRole(workspaceId, uid);
      if (!role) {
        res.status(403).json({ error: "Not a member of this workspace" });
        return;
      }

      // IP allowlist check — must pass before attaching workspace context
      const clientIp =
        req.ip ?? (req.connection as { remoteAddress?: string }).remoteAddress ?? "";
      const ipAllowed = await checkIpAllowlist(workspaceId, clientIp);
      if (!ipAllowed) {
        res.status(403).json({ error: "IP address not permitted for this workspace" });
        return;
      }

      // Viewers are read-only across every workspace-scoped router. Routers
      // needing a higher bar add requireRole() on top of this floor.
      if (role === "viewer" && !SAFE_METHODS.has(req.method)) {
        res.status(403).json({ error: "Viewers have read-only access to this workspace" });
        return;
      }

      (req as WorkspaceAwareRequest).workspace = { workspaceId, role };
      next();
    } catch {
      res.status(500).json({ error: "Workspace resolution failed" });
    }
  };
}
