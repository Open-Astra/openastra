// ── IP Allowlist Routes ───────────────────────────────────────────────
// Mount: app.use("/security/ip-allowlist", jwtAuth(), workspaceResolver(), createIpAllowlistRouter())
//
// GET  /security/ip-allowlist  — retrieve the current IP allowlist config
// PUT  /security/ip-allowlist  — replace the IP allowlist config (owner only)

import { Router } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import {
  getIpAllowlist,
  upsertIpAllowlist,
} from "../../security/ip-allowlist.js";

// ── Validation ────────────────────────────────────────────────────────

const UpsertBody = z.object({
  allowedCidrs: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
});

// ── Helper ────────────────────────────────────────────────────────────

function resolveWorkspaceId(
  req: WorkspaceAwareRequest & AuthenticatedRequest,
): string {
  return req.workspace.workspaceId ?? req.uid;
}

// ── Router ────────────────────────────────────────────────────────────

export function createIpAllowlistRouter(): Router {
  const router = Router();

  // GET / — retrieve current IP allowlist for the workspace
  router.get("/", async (req, res) => {
    const r = req as unknown as WorkspaceAwareRequest & AuthenticatedRequest;
    const workspaceId = resolveWorkspaceId(r);

    try {
      const config = await getIpAllowlist(workspaceId);
      res.json(config);
    } catch (err) {
      console.error("[ip-allowlist] GET error:", err);
      res.status(500).json({ error: "Failed to retrieve IP allowlist" });
    }
  });

  // PUT / — replace the IP allowlist (owner only)
  router.put("/", requireRole("owner"), async (req, res) => {
    const parsed = UpsertBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const r = req as unknown as WorkspaceAwareRequest & AuthenticatedRequest;
    const workspaceId = resolveWorkspaceId(r);
    const { allowedCidrs, enabled } = parsed.data;

    try {
      const config = await upsertIpAllowlist(workspaceId, allowedCidrs, enabled);
      res.json(config);
    } catch (err) {
      console.error("[ip-allowlist] PUT error:", err);
      res.status(500).json({ error: "Failed to update IP allowlist" });
    }
  });

  return router;
}
