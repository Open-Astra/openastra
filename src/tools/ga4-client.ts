// ── GA4 API Client ────────────────────────────────────────────────────
// Wrapper around Google Analytics Data API v1 for querying GA4 properties.
// Handles authentication via service account and executes analytics queries.

import { BetaAnalyticsDataClient } from "@google-analytics/data";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("ga4-client");

export interface GA4QueryOptions {
  propertyId: string;
  dimensions?: string[];
  metrics: string[];
  dateRanges: Array<{ startDate: string; endDate: string }>;
  dimensionFilter?: Record<string, string | string[]>;
  limit?: number;
  orderBy?: Array<{ dimension?: string; metric?: string; desc?: boolean }>;
}

export interface GA4Row {
  dimensions: string[];
  metricValues: string[];
}

export interface GA4QueryResult {
  rows: GA4Row[];
  dimensionHeaders: Array<{ name: string }>;
  metricHeaders: Array<{ name: string; type: string }>;
  rowCount: number;
  isDataGolden: boolean;
}

let cachedClient: BetaAnalyticsDataClient | null = null;

function initializeClient(serviceAccountJson: string): BetaAnalyticsDataClient {
  try {
    const credentials = JSON.parse(serviceAccountJson);
    return new BetaAnalyticsDataClient({
      credentials,
    });
  } catch (err) {
    logger.error("Failed to initialize GA4 client:", err);
    throw new Error("Invalid GA4 service account credentials");
  }
}

export async function queryGA4(
  serviceAccountJson: string,
  options: GA4QueryOptions,
): Promise<GA4QueryResult> {
  if (!cachedClient) {
    cachedClient = initializeClient(serviceAccountJson);
  }

  try {
    const request = {
      property: `properties/${options.propertyId}`,
      dateRanges: options.dateRanges,
      dimensions: (options.dimensions || []).map((d) => ({ name: d })),
      metrics: options.metrics.map((m) => ({ name: m })),
      limit: options.limit || 10000,
      orderBys: options.orderBy
        ? options.orderBy.map((o) => ({
            dimension: o.dimension ? { name: o.dimension } : undefined,
            metric: o.metric ? { name: o.metric } : undefined,
            descending: o.desc ?? false,
          }))
        : undefined,
      dimensionFilter: options.dimensionFilter
        ? buildDimensionFilter(options.dimensionFilter)
        : undefined,
    };

    const response = await cachedClient.runReport(request as any);

    return {
      rows: (response[0].rows || []).map((row: any) => ({
        dimensions: row.dimensionValues?.map((v: any) => v.value) || [],
        metricValues: row.metricValues?.map((v: any) => v.value) || [],
      })),
      dimensionHeaders: (response[0].dimensionHeaders || []).map((h: any) => ({ name: h.name })),
      metricHeaders: (response[0].metricHeaders || []).map((h: any) => ({ name: h.name, type: h.type })),
      rowCount: response[0].rowCount || 0,
      isDataGolden: (response[0] as any).goldSet || false,
    };
  } catch (err) {
    logger.error("GA4 query failed:", err);
    throw new Error(`GA4 query failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function getRealtimeData(
  serviceAccountJson: string,
  propertyId: string,
  metrics: string[] = ["activeUsers"],
): Promise<GA4QueryResult> {
  if (!cachedClient) {
    cachedClient = initializeClient(serviceAccountJson);
  }

  try {
    const request = {
      property: `properties/${propertyId}`,
      metrics: metrics.map((m) => ({ name: m })),
    };

    const response = await cachedClient.runRealtimeReport(request as any);

    return {
      rows: (response[0].rows || []).map((row: any) => ({
        dimensions: row.dimensionValues?.map((v: any) => v.value) || [],
        metricValues: row.metricValues?.map((v: any) => v.value) || [],
      })),
      dimensionHeaders: (response[0].dimensionHeaders || []).map((h: any) => ({ name: h.name })),
      metricHeaders: (response[0].metricHeaders || []).map((h: any) => ({ name: h.name, type: h.type })),
      rowCount: response[0].rowCount || 0,
      isDataGolden: false,
    };
  } catch (err) {
    logger.error("GA4 realtime query failed:", err);
    throw new Error(
      `GA4 realtime query failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function buildDimensionFilter(
  filters: Record<string, string | string[]>,
): Record<string, any> {
  const filterExpressions: any[] = [];

  for (const [dimension, value] of Object.entries(filters)) {
    if (Array.isArray(value)) {
      filterExpressions.push({
        orGroup: {
          expressions: value.map((v) => ({
            filter: {
              fieldName: dimension,
              stringFilter: {
                matchType: "EXACT",
                value: v,
              },
            },
          })),
        },
      });
    } else {
      filterExpressions.push({
        filter: {
          fieldName: dimension,
          stringFilter: {
            matchType: "EXACT",
            value,
          },
        },
      });
    }
  }

  if (filterExpressions.length === 1) {
    return filterExpressions[0];
  }

  return {
    andGroup: {
      expressions: filterExpressions,
    },
  };
}
