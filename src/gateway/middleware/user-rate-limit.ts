import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "./auth.js";
import { loadEnv } from "../../config/env.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("user-rate-limit");

const windowStore = new Map<string, number[]>();
const WINDOW_MS = 60_000;

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [uid, timestamps] of windowStore) {
    const fresh = timestamps.filter((ts) => ts > cutoff);
    if (fresh.length === 0) windowStore.delete(uid);
    else windowStore.set(uid, fresh);
  }
}, 5 * 60_000).unref();

export function userRateLimit() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const uid = (req as AuthenticatedRequest).uid;
    if (!uid) { next(); return; }

    const env = loadEnv();
    const rpm = env.userRateLimitRpm;
    const burst = env.userRateLimitBurst;
    const now = Date.now();
    const cutoff = now - WINDOW_MS;

    let timestamps = windowStore.get(uid) ?? [];
    timestamps = timestamps.filter((ts) => ts > cutoff);
    const count = timestamps.length;

    if (count >= rpm + burst) {
      const oldestTs = timestamps[0] ?? now;
      const retryAfterMs = Math.max(0, WINDOW_MS - (now - oldestTs));
      res.setHeader("X-RateLimit-Limit", rpm);
      res.setHeader("X-RateLimit-Remaining", 0);
      res.setHeader("X-RateLimit-Reset", Math.ceil((now + retryAfterMs) / 1000));
      log.warn(`Rate limit exceeded: uid=${uid} count=${count} rpm=${rpm}`);
      res.status(429).json({ error: "rate_limit_exceeded", retryAfterMs, limit: rpm, remaining: 0 });
      return;
    }

    timestamps.push(now);
    windowStore.set(uid, timestamps);
    const remaining = Math.max(0, rpm - count - 1);
    const resetAt = timestamps[0] != null
      ? Math.ceil((timestamps[0] + WINDOW_MS) / 1000)
      : Math.ceil((now + WINDOW_MS) / 1000);
    res.setHeader("X-RateLimit-Limit", rpm);
    res.setHeader("X-RateLimit-Remaining", remaining);
    res.setHeader("X-RateLimit-Reset", resetAt);
    next();
  };
}
