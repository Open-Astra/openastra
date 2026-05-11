import { Router } from "express";
import { getPool, pingPostgres } from "../../config/postgres.js";
import { getTypesense } from "../../config/typesense.js";
import { getConnectedUserCount } from "../ws.js";
import { getRegisteredToolCount } from "../../tools/index.js";
import { getSkillManifests } from "../../skills/registry.js";
import { getCacheStats } from "../../tools/cache.js";
import { jwtAuth } from "../middleware/auth.js";

// ── Metrics & Readiness Routes ──────────────────────────────────
// Provides operational metrics and Kubernetes-style readiness probes.

const startedAt = Date.now();

export function createMetricsRouter(): Router {
  const router = Router();

  // GET /readiness — Kubernetes-style readiness probe
  // Returns 200 if the service can handle requests, 503 otherwise.
  router.get("/readiness", async (_req, res) => {
    try {
      const pgOk = await pingPostgres();
      if (!pgOk) {
        res.status(503).json({ ready: false, reason: "postgres unavailable" });
        return;
      }

      try {
        await getTypesense().health.retrieve();
      } catch {
        res.status(503).json({ ready: false, reason: "typesense unavailable" });
        return;
      }

      res.json({ ready: true });
    } catch {
      res.status(503).json({ ready: false, reason: "unknown" });
    }
  });

  // GET /metrics — operational metrics (requires auth — exposes billing/session stats)
  router.get("/metrics", jwtAuth(), async (_req, res) => {
    const pool = getPool();

    // Gather stats in parallel
    const [sessionStats, messageStats, memoryStats, billingStats] = await Promise.all([
      pool.query<{ status: string; count: string }>(
        "SELECT status, COUNT(*) as count FROM sessions GROUP BY status",
      ).catch(() => ({ rows: [] as Array<{ status: string; count: string }> })),

      pool.query<{ total: string }>(
        "SELECT COUNT(*) as total FROM messages",
      ).catch(() => ({ rows: [{ total: "0" }] })),

      pool.query<{ total: string }>(
        "SELECT COUNT(*) as total FROM daily_memory",
      ).catch(() => ({ rows: [{ total: "0" }] })),

      pool.query<{ total_tokens: string; request_count: number }>(
        `SELECT SUM(total_tokens) as total_tokens, SUM(request_count) as request_count
         FROM billing_usage WHERE month = to_char(NOW(), 'YYYY-MM')`,
      ).catch(() => ({ rows: [{ total_tokens: "0", request_count: 0 }] })),
    ]);

    const sessionsByStatus: Record<string, number> = {};
    for (const row of sessionStats.rows) {
      sessionsByStatus[row.status] = parseInt(row.count, 10);
    }

    const cacheStats = getCacheStats();

    res.json({
      uptime: {
        ms: Date.now() - startedAt,
        startedAt: new Date(startedAt).toISOString(),
      },
      connections: {
        websocket: getConnectedUserCount(),
      },
      registry: {
        tools: getRegisteredToolCount(),
        skills: getSkillManifests().length,
      },
      sessions: sessionsByStatus,
      messages: {
        total: parseInt(messageStats.rows[0]?.total ?? "0", 10),
      },
      memory: {
        dailyRows: parseInt(memoryStats.rows[0]?.total ?? "0", 10),
      },
      billing: {
        monthlyTokens: parseInt(billingStats.rows[0]?.total_tokens ?? "0", 10),
        monthlyRequests: billingStats.rows[0]?.request_count ?? 0,
      },
      cache: cacheStats,
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}
