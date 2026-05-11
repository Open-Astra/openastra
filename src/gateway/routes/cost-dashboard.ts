import { Router } from "express";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { getWorkspaceCostBreakdown } from "../../billing/cost-dashboard.js";

// ── Cost Dashboard Router ───────────────────────────────────────────

export function createCostDashboardRouter(): Router {
  const router = Router();

  // GET /costs — workspace cost summary (defaults to last 3 months)
  router.get("/", async (req, res) => {
    try {
      const wsReq = req as WorkspaceAwareRequest;
      const workspaceId = wsReq.workspace?.workspaceId ?? null;
      if (!workspaceId) {
        res.status(400).json({ error: "Workspace required to view costs" });
        return;
      }
      const months = parseInt(req.query.months as string) || 3;
      const breakdown = await getWorkspaceCostBreakdown(workspaceId, { months });
      res.json(breakdown);
    } catch (err) {
      console.error("[costs] Error fetching cost summary:", err);
      res.status(500).json({ error: "Failed to fetch cost summary" });
    }
  });

  // GET /costs/breakdown — detailed breakdown with date range
  router.get("/breakdown", async (req, res) => {
    try {
      const wsReq = req as WorkspaceAwareRequest;
      const workspaceId = wsReq.workspace?.workspaceId ?? null;
      if (!workspaceId) {
        res.status(400).json({ error: "Workspace required to view cost breakdown" });
        return;
      }
      const months = parseInt(req.query.months as string) || 3;
      const startDate = req.query.startDate as string | undefined;
      const endDate = req.query.endDate as string | undefined;

      const breakdown = await getWorkspaceCostBreakdown(workspaceId, {
        months,
        startDate,
        endDate,
      });

      res.json({
        ...breakdown,
        meta: {
          workspaceId,
          months,
          startDate: startDate ?? null,
          endDate: endDate ?? null,
          generatedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      console.error("[costs] Error fetching cost breakdown:", err);
      res.status(500).json({ error: "Failed to fetch cost breakdown" });
    }
  });

  return router;
}
