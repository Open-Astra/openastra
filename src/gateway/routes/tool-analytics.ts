import { Router } from "express";
import { getToolStats, getToolHistogram } from "../../observability/tool-analytics.js";
import { getAnomalyDetector } from "../../observability/tool-anomaly-detector.js";
import { WorkspaceAwareRequest } from "../../gateway/middleware/workspace.js";
import { getPool } from "../../config/postgres.js";

export function createToolAnalyticsRouter(): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
    if (!workspaceId) return res.status(400).json({ error: "workspace required" });

    const toolName = req.query["toolName"] !== undefined ? String(req.query["toolName"]) : undefined;
    const windowHours = req.query["windowHours"] !== undefined ? Number(req.query["windowHours"]) : 24;

    const stats = await getToolStats(workspaceId, toolName, windowHours);
    res.json(stats);
  });

  router.get("/histogram/:toolName", async (req, res) => {
    const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
    if (!workspaceId) return res.status(400).json({ error: "workspace required" });

    const windowHours = req.query["windowHours"] !== undefined ? Number(req.query["windowHours"]) : 24;
    const histogram = await getToolHistogram(workspaceId, req.params["toolName"]!, windowHours);
    res.json(histogram);
  });

  router.get("/anomalies", async (req, res) => {
    const limit = req.query["limit"] !== undefined ? Number(req.query["limit"]) : 50;
    const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 50;

    const inMemoryAlerts = getAnomalyDetector()?.getRecentAlerts(normalizedLimit) ?? [];
    if (inMemoryAlerts.length > 0) {
      res.json({ alerts: inMemoryAlerts });
      return;
    }

    try {
      const { rows } = await getPool().query(
        `SELECT id,
                rule_id AS "ruleId",
                severity,
                tool_name AS "toolName",
                agent_id AS "agentId",
                uid,
                description,
                metadata,
                created_at AS "timestamp"
         FROM tool_anomaly_alerts
         ORDER BY created_at DESC
         LIMIT $1`,
        [normalizedLimit],
      );

      res.json({
        alerts: rows.map((row) => ({
          ...row,
          ruleName: humanizeRuleId(String(row.ruleId)),
        })),
      });
    } catch (err) {
      console.error("[tool-analytics] anomalies:", err);
      res.status(500).json({ error: "Failed to load anomaly alerts" });
    }
  });

  return router;
}

function humanizeRuleId(ruleId: string): string {
  return ruleId
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
