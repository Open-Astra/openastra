// ── Differential Privacy Budget Routes ───────────────────────────────
// Mount: app.use("/security/dp-budget", jwtAuth(), workspaceResolver(), createDpBudgetRouter())
//
// GET  /security/dp-budget       — get current DP budget status for the caller
// POST /security/dp-budget/reset — reset DP budget for a user (admin only)

import { Router } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import {
  getDpBudgetStatus,
  resetDpBudget,
} from "../../security/dp-budget.js";

// ── Validation ────────────────────────────────────────────────────────

const ResetBody = z.object({
  uid: z.string().min(1),
});

// ── Helper ────────────────────────────────────────────────────────────

function resolveWorkspaceId(
  req: WorkspaceAwareRequest & AuthenticatedRequest,
): string {
  return req.workspace.workspaceId ?? req.uid;
}

// ── Router ────────────────────────────────────────────────────────────

export function createDpBudgetRouter(): Router {
  const router = Router();

  // GET / — return current DP budget status for the authenticated user
  router.get("/", async (req, res) => {
    const r = req as unknown as WorkspaceAwareRequest & AuthenticatedRequest;
    const workspaceId = resolveWorkspaceId(r);

    try {
      const status = await getDpBudgetStatus(workspaceId, r.uid);
      res.json(status);
    } catch (err) {
      console.error("[dp-budget] GET error:", err);
      res.status(500).json({ error: "Failed to retrieve DP budget status" });
    }
  });

  // POST /reset — reset DP budget for a specific user (owner only)
  router.post("/reset", requireRole("owner"), async (req, res) => {
    const parsed = ResetBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const r = req as unknown as WorkspaceAwareRequest & AuthenticatedRequest;
    const workspaceId = resolveWorkspaceId(r);
    const { uid } = parsed.data;

    try {
      await resetDpBudget(workspaceId, uid);
      const status = await getDpBudgetStatus(workspaceId, uid);
      res.json({ reset: true, status });
    } catch (err) {
      console.error("[dp-budget] POST /reset error:", err);
      res.status(500).json({ error: "Failed to reset DP budget" });
    }
  });

  return router;
}
