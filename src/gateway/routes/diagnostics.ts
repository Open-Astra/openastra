import { Router, type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import {
  runDiagnostics,
  runConnectivityChecks,
  persistDiagnosticRun,
  getDiagnosticHistory,
} from "../../diagnostics/index.js";
import { getAllCircuitBreakerStates } from "../../inference/circuit-breaker.js";
import { getPool } from "../../config/postgres.js";

// ── Diagnostics Router ───────────────────────────────────────────────
// Exposes diagnostic endpoints protected by internal API key auth.
//   GET /diagnostics       — full diagnostic run
//   GET /diagnostics/quick — connectivity checks only
//   GET /diagnostics/history — last 10 diagnostic runs

export function createDiagnosticsRouter(): Router {
  const router = Router();

  // Auth: check x-api-key header against INTERNAL_API_KEY
  router.use((req: Request, res: Response, next: NextFunction): void => {
    const expected = process.env.INTERNAL_API_KEY;
    if (!expected) {
      res.status(500).json({ error: "Server misconfigured — INTERNAL_API_KEY not set" });
      return;
    }

    const provided = req.headers["x-api-key"];
    if (
      typeof provided !== "string" ||
      provided.length !== expected.length ||
      !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
    ) {
      res.status(401).json({ error: "Invalid or missing API key" });
      return;
    }

    next();
  });

  // GET /diagnostics — full diagnostic run
  router.get("/", async (_req: Request, res: Response) => {
    try {
      const result = await runDiagnostics();
      // Persist asynchronously — don't block the response
      persistDiagnosticRun(result).catch(() => {
        // Non-fatal: log but don't fail the response
      });

      const statusCode = result.overallStatus === "healthy" ? 200
        : result.overallStatus === "degraded" ? 200
        : 503;

      res.status(statusCode).json({
        ...result,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // GET /diagnostics/quick — connectivity checks only
  router.get("/quick", async (_req: Request, res: Response) => {
    try {
      const result = await runConnectivityChecks();

      const statusCode = result.overallStatus === "unhealthy" ? 503 : 200;

      res.status(statusCode).json({
        ...result,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // GET /diagnostics/history — last 10 runs from diagnostic_runs table
  router.get("/history", async (_req: Request, res: Response) => {
    try {
      const runs = await getDiagnosticHistory(10);
      res.json({ runs });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // GET /diagnostics/circuit-breakers — current state of all circuit breakers
  router.get("/circuit-breakers", (_req: Request, res: Response) => {
    const states = getAllCircuitBreakerStates();
    const providers = Object.entries(states).map(([provider, s]) => ({
      provider,
      state: s.state,
      totalRequests: s.totalRequests,
      totalSuccesses: s.totalSuccesses,
      p50Ms: s.p50Ms,
      p95Ms: s.p95Ms,
      p99Ms: s.p99Ms,
      errorRate: s.totalRequests > 0
        ? ((s.totalRequests - s.totalSuccesses) / s.totalRequests * 100).toFixed(1) + "%"
        : "0%",
      lastFailureAt: s.lastFailureAt ? new Date(s.lastFailureAt).toISOString() : null,
    }));
    res.json({ providers, timestamp: new Date().toISOString() });
  });

  // GET /diagnostics/circuit-breakers/history — last 100 state transitions from circuit_breaker_history
  router.get("/circuit-breakers/history", async (_req: Request, res: Response) => {
    try {
      const pool = getPool();
      const result = await pool.query(
        `SELECT id, provider, from_state, to_state, reason, total_requests, error_rate, transitioned_at
         FROM circuit_breaker_history
         ORDER BY transitioned_at DESC
         LIMIT 100`,
      );
      res.json({ history: result.rows, timestamp: new Date().toISOString() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  return router;
}
