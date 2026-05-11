import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "./auth.js";
import { getPool } from "../../config/postgres.js";

// ── Rate Limiter Types ──────────────────────────────────────────────

interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
}

// ── Postgres-Backed Sliding Window Rate Limiter ─────────────────────
// Persists rate limit state in Postgres so it survives restarts and
// works correctly across multiple gateway instances. Falls back to
// in-memory if Postgres is unavailable.
//
// Uses a single table: rate_limit_entries(key, timestamp)
// Cleaned up periodically by pruning old rows.

let _tableEnsured = false;

async function ensureRateLimitTable(): Promise<void> {
  if (_tableEnsured) return;
  try {
    const pool = getPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rate_limit_entries (
        key TEXT NOT NULL,
        ts BIGINT NOT NULL
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_rate_limit_key_ts
      ON rate_limit_entries (key, ts)
    `);
    _tableEnsured = true;
  } catch {
    // Table creation failed — will fall back to in-memory
  }
}

// Schedule periodic cleanup of old entries
let _cleanupScheduled = false;

function scheduleCleanup(maxWindowMs: number): void {
  if (_cleanupScheduled) return;
  _cleanupScheduled = true;

  const interval = Math.max(maxWindowMs * 2, 120_000); // At least every 2 min
  setInterval(async () => {
    try {
      const pool = getPool();
      const cutoff = Date.now() - maxWindowMs;
      await pool.query("DELETE FROM rate_limit_entries WHERE ts < $1", [cutoff]);
    } catch {
      // Ignore cleanup errors
    }
  }, interval).unref();
}

// ── In-Memory Fallback ──────────────────────────────────────────────
// Used when Postgres is unavailable to avoid blocking requests.

interface WindowEntry {
  timestamps: number[];
}

function createInMemoryStore(windowMs: number) {
  const store = new Map<string, WindowEntry>();

  const CLEANUP_INTERVAL = Math.max(windowMs * 2, 60_000);
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      entry.timestamps = entry.timestamps.filter((ts) => now - ts < windowMs);
      if (entry.timestamps.length === 0) {
        store.delete(key);
      }
    }
  }, CLEANUP_INTERVAL).unref();

  return {
    async count(key: string, now: number): Promise<number> {
      const entry = store.get(key);
      if (!entry) return 0;
      entry.timestamps = entry.timestamps.filter((ts) => now - ts < windowMs);
      return entry.timestamps.length;
    },
    async record(key: string, now: number): Promise<void> {
      let entry = store.get(key);
      if (!entry) {
        entry = { timestamps: [] };
        store.set(key, entry);
      }
      entry.timestamps.push(now);
    },
    async oldest(key: string, now: number): Promise<number> {
      const entry = store.get(key);
      if (!entry) return now;
      const valid = entry.timestamps.filter((ts) => now - ts < windowMs);
      return valid[0] ?? now;
    },
  };
}

// ── Postgres Store ─────────────────────────────────────────────────

function createPgStore(windowMs: number) {
  const fallback = createInMemoryStore(windowMs);
  let useFallback = false;

  return {
    async count(key: string, now: number): Promise<number> {
      if (useFallback) return fallback.count(key, now);
      try {
        const pool = getPool();
        const cutoff = now - windowMs;
        const result = await pool.query(
          "SELECT COUNT(*)::int AS cnt FROM rate_limit_entries WHERE key = $1 AND ts >= $2",
          [key, cutoff],
        );
        return result.rows[0]?.cnt ?? 0;
      } catch {
        useFallback = true;
        return fallback.count(key, now);
      }
    },
    async record(key: string, now: number): Promise<void> {
      if (useFallback) return fallback.record(key, now);
      try {
        const pool = getPool();
        await pool.query(
          "INSERT INTO rate_limit_entries (key, ts) VALUES ($1, $2)",
          [key, now],
        );
      } catch {
        useFallback = true;
        return fallback.record(key, now);
      }
    },
    async oldest(key: string, now: number): Promise<number> {
      if (useFallback) return fallback.oldest(key, now);
      try {
        const pool = getPool();
        const cutoff = now - windowMs;
        const result = await pool.query(
          "SELECT ts FROM rate_limit_entries WHERE key = $1 AND ts >= $2 ORDER BY ts ASC LIMIT 1",
          [key, cutoff],
        );
        return result.rows[0]?.ts ? Number(result.rows[0].ts) : now;
      } catch {
        useFallback = true;
        return fallback.oldest(key, now);
      }
    },
  };
}

// ── Rate Limiter Middleware ──────────────────────────────────────────

export function rateLimiter(options: RateLimitOptions) {
  const { windowMs, maxRequests } = options;

  // Ensure table exists on first use
  ensureRateLimitTable().catch(() => {});
  scheduleCleanup(windowMs);

  const store = createPgStore(windowMs);

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const uid = (req as AuthenticatedRequest).uid;
    const key = uid || req.ip || "unknown";
    const now = Date.now();

    try {
      const count = await store.count(key, now);

      if (count >= maxRequests) {
        const oldestTs = await store.oldest(key, now);
        const retryAfterMs = windowMs - (now - oldestTs);

        res.status(429).json({
          error: "Rate limit exceeded",
          retryAfterMs: Math.max(retryAfterMs, 0),
        });
        return;
      }

      // Record this request
      await store.record(key, now);

      // Set rate limit headers
      res.setHeader("X-RateLimit-Limit", maxRequests);
      res.setHeader("X-RateLimit-Remaining", Math.max(0, maxRequests - count - 1));

      next();
    } catch {
      // On any error, allow the request through (fail-open)
      next();
    }
  };
}

// ── Granular Multi-Window Rate Limiter ────────────────────────────
// Supports multiple concurrent windows: per-second (burst), per-minute,
// and per-hour. A request is rejected if ANY window is exceeded.
// Returns headers indicating remaining capacity.

interface GranularRateLimitOptions {
  perSecond?: number;  // burst protection (default: 5)
  perMinute?: number;  // sustained rate (default: 30)
  perHour?: number;    // hourly cap (default: 500)
}

export function granularRateLimiter(options: GranularRateLimitOptions = {}) {
  const limits = {
    second: { windowMs: 1_000, max: options.perSecond ?? 5 },
    minute: { windowMs: 60_000, max: options.perMinute ?? 30 },
    hour: { windowMs: 3_600_000, max: options.perHour ?? 500 },
  };

  // Use per-hour window for Postgres store (covers all windows)
  ensureRateLimitTable().catch(() => {});
  scheduleCleanup(limits.hour.windowMs);

  const store = createPgStore(limits.hour.windowMs);

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const uid = (req as AuthenticatedRequest).uid;
    const key = uid || req.ip || "unknown";
    const now = Date.now();

    try {
      // Record this request first to get accurate counts
      // (we'll check before committing below)

      // Check each window
      for (const [windowName, { windowMs, max }] of Object.entries(limits)) {
        // Count entries in this window from Postgres
        const pool = getPool();
        const cutoff = now - windowMs;
        const result = await pool.query(
          "SELECT COUNT(*)::int AS cnt FROM rate_limit_entries WHERE key = $1 AND ts >= $2",
          [key, cutoff],
        );
        const countInWindow = result.rows[0]?.cnt ?? 0;

        if (countInWindow >= max) {
          const oldestResult = await pool.query(
            "SELECT ts FROM rate_limit_entries WHERE key = $1 AND ts >= $2 ORDER BY ts ASC LIMIT 1",
            [key, cutoff],
          );
          const oldestTs = oldestResult.rows[0]?.ts ? Number(oldestResult.rows[0].ts) : now;
          const retryAfterMs = windowMs - (now - oldestTs);

          res.status(429).json({
            error: `Rate limit exceeded (${windowName}: ${max}/${windowMs}ms)`,
            window: windowName,
            limit: max,
            retryAfterMs: Math.max(retryAfterMs, 0),
          });
          return;
        }
      }

      // All windows OK — record and proceed
      await store.record(key, now);

      // Set rate limit headers for the per-minute window
      const minuteCutoff = now - limits.minute.windowMs;
      const pool = getPool();
      const minuteResult = await pool.query(
        "SELECT COUNT(*)::int AS cnt FROM rate_limit_entries WHERE key = $1 AND ts >= $2",
        [key, minuteCutoff],
      );
      const minuteCount = minuteResult.rows[0]?.cnt ?? 0;
      res.setHeader("X-RateLimit-Limit", limits.minute.max);
      res.setHeader("X-RateLimit-Remaining", Math.max(0, limits.minute.max - minuteCount));

      next();
    } catch {
      // Fail-open on errors
      next();
    }
  };
}
