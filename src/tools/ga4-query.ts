// ── GA4 Query Tool ────────────────────────────────────────────────────
// Execute flexible GA4 analytics queries with dimensions, metrics, and filters.
// Supports date ranges, ordering, and dimension filtering.

import { z } from "zod";
import { registerTool } from "./registry.js";
import { queryGA4 } from "./ga4-client.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("ga4-query");

const Params = z.object({
  propertyId: z.string().describe("GA4 property ID (numeric)"),
  metrics: z
    .array(z.string())
    .describe(
      "Metrics to query: activeUsers, screenPageViews, eventCount, conversions, sessions, etc.",
    ),
  dimensions: z
    .array(z.string())
    .optional()
    .describe(
      "Dimensions to break down by: pagePath, country, deviceCategory, eventName, etc.",
    ),
  startDate: z.string().describe("Start date in YYYY-MM-DD format (or 'NdaysAgo', 'yesterday', 'today')"),
  endDate: z.string().describe("End date in YYYY-MM-DD format"),
  filters: z
    .record(z.string(), z.union([z.string(), z.array(z.string())]))
    .optional()
    .describe("Dimension filters: { pagePath: '/about', country: ['US', 'CA'] }"),
  orderBy: z
    .array(
      z.object({
        metric: z.string().optional(),
        dimension: z.string().optional(),
        desc: z.boolean().optional().default(true),
      }),
    )
    .optional()
    .describe("Order results by metric or dimension"),
  limit: z.number().optional().default(100).describe("Max rows to return (default 100, max 10000)"),
});

registerTool({
  name: "ga4-query",
  description:
    "Execute a GA4 analytics query with flexible dimensions, metrics, and filters. Returns page views, events, users, conversions, etc.",
  parameters: Params,
  execute: async (params, ctx) => {
    if (!ctx.workspaceId) {
      return {
        success: false,
        error: "Workspace context required for GA4 access",
      };
    }

    try {
      // Fetch GA4 credentials from env var
      const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

      if (!serviceAccountJson) {
        return {
          success: false,
          error:
            "GA4 service account not configured. Set GOOGLE_SERVICE_ACCOUNT_JSON env var.",
        };
      }

      // Parse date format (support relative dates)
      const normalizedStart = normalizeDateRange(params.startDate);
      const normalizedEnd = normalizeDateRange(params.endDate);

      const result = await queryGA4(serviceAccountJson, {
        propertyId: params.propertyId,
        metrics: params.metrics,
        dimensions: params.dimensions,
        dateRanges: [
          {
            startDate: normalizedStart,
            endDate: normalizedEnd,
          },
        ],
        dimensionFilter: params.filters,
        limit: Math.min(params.limit || 100, 10000),
        orderBy: params.orderBy,
      });

      // Format results as readable table
      const table = formatResultsTable(result);

      logger.info(`GA4 query completed: ${result.rowCount} rows from ${params.propertyId}`);

      return {
        success: true,
        propertyId: params.propertyId,
        dateRange: `${normalizedStart} to ${normalizedEnd}`,
        rowCount: result.rowCount,
        isDataGolden: result.isDataGolden,
        table,
        rawData: result.rows,
      };
    } catch (err) {
      logger.error("GA4 query failed:", err);
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
});

function normalizeDateRange(dateStr: string): string {
  if (dateStr.match(/^\d{1,2}daysAgo$/)) {
    const days = parseInt(dateStr, 10);
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString().split("T")[0]!;
  }
  if (dateStr === "yesterday") {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().split("T")[0]!;
  }
  if (dateStr === "today") {
    return new Date().toISOString().split("T")[0]!;
  }
  return dateStr;
}

function formatResultsTable(result: any): string {
  if (result.rows.length === 0) {
    return "No data found";
  }

  const headers = [
    ...result.dimensionHeaders.map((h: any) => h.name),
    ...result.metricHeaders.map((h: any) => h.name),
  ];

  const rows = result.rows.map((row: any) => [...row.dimensions, ...row.metricValues]);

  // Simple ASCII table
  const colWidths = headers.map((h: string) => h.length);
  rows.forEach((row: string[]) => {
    row.forEach((cell: string, i: number) => {
      colWidths[i] = Math.max(colWidths[i], String(cell).length);
    });
  });

  const separator = "+" + colWidths.map((w) => "-".repeat(w + 2)).join("+") + "+";
  const headerRow =
    "|" +
    headers
      .map((h: string, i: number) => ` ${h.padEnd(colWidths[i])} `)
      .join("|") +
    "|";

  const dataRows = rows
    .map(
      (row: string[]) =>
        "|" + row.map((cell: string, i: number) => ` ${String(cell).padEnd(colWidths[i])} `).join("|") + "|",
    )
    .join("\n");

  return [separator, headerRow, separator, dataRows, separator].join("\n");
}
