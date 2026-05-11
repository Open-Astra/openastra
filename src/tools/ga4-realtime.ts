// ── GA4 Realtime Tool ─────────────────────────────────────────────────
// Get real-time analytics data (active users in the last 30 minutes).

import { z } from "zod";
import { registerTool } from "./registry.js";
import { getRealtimeData } from "./ga4-client.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("ga4-realtime");

const Params = z.object({
  propertyId: z.string().describe("GA4 property ID"),
  metrics: z
    .array(z.string())
    .optional()
    .default(["activeUsers"])
    .describe("Real-time metrics: activeUsers, screenPageViews, etc."),
  dimensions: z
    .array(z.string())
    .optional()
    .describe("Optional dimensions: pagePath, country, deviceCategory, etc."),
});

registerTool({
  name: "ga4-realtime",
  description:
    "Get real-time GA4 data (active users in the last 30 minutes). Useful for monitoring current traffic.",
  parameters: Params,
  execute: async (params, ctx) => {
    if (!ctx.workspaceId) {
      return {
        success: false,
        error: "Workspace context required for GA4 access",
      };
    }

    try {
      const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

      if (!serviceAccountJson) {
        return {
          success: false,
          error:
            "GA4 service account not configured. Set GOOGLE_SERVICE_ACCOUNT_JSON env var.",
        };
      }

      const result = await getRealtimeData(
        serviceAccountJson,
        params.propertyId,
        params.metrics,
      );

      logger.info(`GA4 realtime query completed: ${result.rowCount} rows`);

      // Format simple text summary
      let summary = `Real-time data for property ${params.propertyId}:\n`;
      if (result.rows.length > 0) {
        const row = result.rows[0];
        params.metrics.forEach((metric, i) => {
          summary += `${metric}: ${row.metricValues[i]}\n`;
        });
      } else {
        summary += "No real-time data available";
      }

      return {
        success: true,
        propertyId: params.propertyId,
        timestamp: new Date().toISOString(),
        summary,
        data: result.rows,
        metrics: result.metricHeaders,
      };
    } catch (err) {
      logger.error("GA4 realtime query failed:", err);
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
});
