// ── Synthetic Transaction Results Router ───────────────────────────────
// Exposes synthetic transaction test results for observability.

import { Router, type Request, type Response } from "express";
import { getRecentSyntheticResults } from "../../heartbeat/synthetic-tx.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("synthetic-tx-routes");

export function createSyntheticTxRouter(): Router {
  const router = Router();

  // GET /synthetic-tx — retrieve recent synthetic transaction results grouped by provider
  router.get("/", async (_req: Request, res: Response) => {
    try {
      const results = await getRecentSyntheticResults(50);

      // Group results by provider
      const grouped: Record<string, typeof results> = {};
      for (const result of results) {
        if (!grouped[result.provider]) {
          grouped[result.provider] = [];
        }
        grouped[result.provider]!.push(result);
      }

      // Compute aggregate stats per provider
      const stats: Record<string, {
        provider: string;
        successCount: number;
        errorCount: number;
        avgLatencyMs: number;
        minLatencyMs: number;
        maxLatencyMs: number;
        recentRuns: typeof results;
      }> = {};

      for (const [provider, providerResults] of Object.entries(grouped)) {
        const successCount = providerResults.filter((r) => r.success).length;
        const errorCount = providerResults.filter((r) => !r.success).length;
        const latencies = providerResults.map((r) => r.latency_ms);
        const avgLatencyMs = latencies.length > 0
          ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
          : 0;
        const minLatencyMs = latencies.length > 0 ? Math.min(...latencies) : 0;
        const maxLatencyMs = latencies.length > 0 ? Math.max(...latencies) : 0;

        stats[provider] = {
          provider,
          successCount,
          errorCount,
          avgLatencyMs,
          minLatencyMs,
          maxLatencyMs,
          recentRuns: providerResults.slice(0, 5),
        };
      }

      res.json({
        status: "ok",
        providers: stats,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      log.error("Failed to fetch synthetic transaction results:", err);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
