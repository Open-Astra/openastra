import { timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import { getPool } from "../../config/postgres.js";
import { getRegisteredToolCount } from "../../tools/index.js";
import { getAllAgentConfigs } from "../../config/agents.js";

// ── Internal API Key Auth ──────────────────────────────────────────

function internalApiKey() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const expected = process.env.INTERNAL_API_KEY;

    if (!expected) {
      console.error("[admin] INTERNAL_API_KEY not configured");
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
      isValid = timingSafeEqual(
        Buffer.from(providedStr),
        Buffer.from(expected),
      );
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

// ── Uptime Tracking ────────────────────────────────────────────────

const startedAt = Date.now();

// ── Admin Router Factory ───────────────────────────────────────────

export function createAdminRouter(): Router {
  const router = Router();

  // All admin routes require internal API key auth
  router.use(internalApiKey());

  // GET /admin/health — Extended health check
  router.get("/health", async (_req: Request, res: Response) => {
    const mem = process.memoryUsage();
    const pool = getPool();

    let activeSessionCount: number | null = null;
    try {
      const { rows } = await pool.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM sessions WHERE status = 'active'",
      );
      activeSessionCount = parseInt(rows[0]?.count ?? "0", 10);
    } catch {
      // Non-fatal
    }

    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      memory: {
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        heapTotalBytes: mem.heapTotal,
        externalBytes: mem.external,
      },
      activeSessionCountEstimate: activeSessionCount,
      registeredToolCount: getRegisteredToolCount(),
    });
  });

  // GET /admin/agents — List all registered agent configs
  router.get("/agents", (_req: Request, res: Response) => {
    const agents = [...getAllAgentConfigs().values()].map((config) => ({
      id: config.id,
      displayName: config.displayName,
      tier: config.tier,
      model: config.model.modelId,
      toolCount: config.tools.allow.length,
      tools: config.tools.allow,
      skills: config.skills,
      maxContextTokens: config.model.maxContextTokens,
      sessionConfig: config.session,
      spawnEnabled: config.spawn.enabled,
    }));

    res.json({ agents });
  });

  // GET /admin/usage/:uid — Token usage summary for a user
  router.get("/usage/:uid", async (req: Request, res: Response) => {
    const { uid } = req.params;
    const pool = getPool();

    try {
      const now = new Date();
      const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

      const { rows } = await pool.query(
        `SELECT * FROM billing_usage WHERE user_id = $1 AND month = $2`,
        [uid, yearMonth],
      );

      if (rows.length === 0) {
        res.json({
          uid,
          period: yearMonth,
          usage: null,
          message: "No usage data for current billing period",
        });
        return;
      }

      res.json({
        uid,
        period: yearMonth,
        usage: rows[0],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[admin] Failed to fetch usage for uid=${uid}:`, err);
      res.status(500).json({ error: message });
    }
  });

  // GET /admin/sessions/:uid — List active sessions for a user
  router.get("/sessions/:uid", async (req: Request, res: Response) => {
    const { uid } = req.params;
    const pool = getPool();

    try {
      const { rows } = await pool.query(
        `SELECT * FROM sessions WHERE user_id = $1 AND status = 'active'
         ORDER BY last_active_at DESC`,
        [uid],
      );

      res.json({ uid, count: rows.length, sessions: rows });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[admin] Failed to fetch sessions for uid=${uid}:`, err);
      res.status(500).json({ error: message });
    }
  });

  // GET /admin/audit/:uid — Recent audit log entries for a user
  router.get("/audit/:uid", async (req: Request, res: Response) => {
    const { uid } = req.params;
    const pool = getPool();

    try {
      const { rows } = await pool.query(
        `SELECT * FROM audit_log WHERE user_id = $1
         ORDER BY timestamp DESC LIMIT 50`,
        [uid],
      );

      res.json({ uid, count: rows.length, entries: rows });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[admin] Failed to fetch audit log for uid=${uid}:`, err);
      res.status(500).json({ error: message });
    }
  });

  return router;
}
