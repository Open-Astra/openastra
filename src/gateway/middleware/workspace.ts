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
// If no header → personal workspace (workspaceId: null, role: "owner").
// If header present → validates membership and attaches context.

export function workspaceResolver() {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const uid = (req as BudgetAwareRequest).uid;
    const workspaceId = req.headers["x-workspace-id"] as string | undefined;

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

      (req as WorkspaceAwareRequest).workspace = { workspaceId, role };
      next();
    } catch {
      res.status(500).json({ error: "Workspace resolution failed" });
    }
  };
}
