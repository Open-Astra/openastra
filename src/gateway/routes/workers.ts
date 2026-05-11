import { timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import { getPool } from "../../config/postgres.js";

// ── Internal API Key Auth (same pattern as admin.ts) ─────────────────

function internalApiKey() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const expected = process.env.INTERNAL_API_KEY;

    if (!expected) {
      res.status(500).json({ error: "Server misconfigured — internal API key not set" });
      return;
    }

    const provided = req.headers["x-api-key"];
    const providedStr = Array.isArray(provided) ? provided[0] : provided;
    if (!providedStr) {
      res.status(401).json({ error: "Invalid or missing API key" });
      return;
    }

    let isValid = false;
    try {
      isValid = timingSafeEqual(Buffer.from(providedStr), Buffer.from(expected));
    } catch {
      isValid = false;
    }

    if (!isValid) {
      res.status(401).json({ error: "Invalid or missing API key" });
      return;
    }

    next();
  };
}

// ── Workers Router ────────────────────────────────────────────────────

export function createWorkersRouter(): Router {
  const router = Router();

  // GET /admin/workers — list active workers (heartbeat within last 60s)
  router.get("/admin/workers", internalApiKey(), async (_req: Request, res: Response) => {
    try {
      const pool = getPool();
      const result = await pool.query<{
        worker_id: string;
        agent_id: string;
        active_sessions: number;
        last_heartbeat: string;
      }>(
        `SELECT worker_id, agent_id, active_sessions, last_heartbeat
         FROM agent_worker_stats
         WHERE last_heartbeat > NOW() - INTERVAL '60 seconds'
         ORDER BY worker_id, agent_id`,
      );

      res.json({ workers: result.rows });
    } catch (err) {
      console.error("[workers] List:", err);
      res.status(500).json({ error: "Failed to list workers" });
    }
  });

  return router;
}
