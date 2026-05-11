import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { getLatencyHeatmap, type HeatmapMetric } from "../../observability/latency-heatmap.js";

// ── Latency Heatmap Router ────────────────────────────────────────────
// GET /observability/latency-heatmap — returns a 7×24 latency matrix

const HeatmapQuery = z.object({
  agentId: z.string().optional(),
  days: z.coerce.number().int().min(1).max(365).default(30),
  metric: z.enum(["p50", "p95"]).default("p50"),
});

export function createLatencyHeatmapRouter(): Router {
  const router = Router();

  // GET /observability/latency-heatmap
  router.get("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;

    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = HeatmapQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.format() });
      return;
    }

    const { agentId, days, metric } = parsed.data;

    try {
      const heatmap = await getLatencyHeatmap(workspaceId, agentId, days, metric as HeatmapMetric);
      res.json(heatmap);
    } catch (err) {
      console.error("[latency-heatmap] Error:", err);
      res.status(500).json({ error: "Failed to compute latency heatmap" });
    }
  });

  return router;
}
