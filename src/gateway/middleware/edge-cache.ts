import { createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

interface CacheEntry {
  body: string;
  status: number;
  headers: Record<string, string>;
  createdAt: number;
  ttlMs: number;
}

const cache = new Map<string, CacheEntry>();
const MAX_ENTRIES = 1000;
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_STALE_MS = 30_000;

function computeKey(req: Request): string {
  const payload = `${req.method}:${req.originalUrl}:${JSON.stringify(req.body ?? {})}`;
  return createHash("sha256").update(payload).digest("hex");
}

function evictOldest(): void {
  if (cache.size <= MAX_ENTRIES) return;
  let oldestKey = "";
  let oldestTime = Infinity;
  for (const [k, v] of cache) {
    if (v.createdAt < oldestTime) {
      oldestTime = v.createdAt;
      oldestKey = k;
    }
  }
  if (oldestKey) cache.delete(oldestKey);
}

export function edgeCache(opts?: { ttlMs?: number; staleMs?: number }) {
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const staleMs = opts?.staleMs ?? DEFAULT_STALE_MS;

  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET") return next();

    const key = computeKey(req);
    const entry = cache.get(key);
    const now = Date.now();

    if (entry) {
      const age = now - entry.createdAt;
      const isFresh = age < entry.ttlMs;
      const isStale = !isFresh && age < entry.ttlMs + staleMs;

      if (isFresh) {
        res.setHeader("X-Cache", "HIT");
        for (const [k, v] of Object.entries(entry.headers)) {
          res.setHeader(k, v);
        }
        return res.status(entry.status).send(entry.body);
      }

      if (isStale) {
        res.setHeader("X-Cache", "STALE");
        for (const [k, v] of Object.entries(entry.headers)) {
          res.setHeader(k, v);
        }
        res.status(entry.status).send(entry.body);

        // Background revalidation — fire and forget
        void Promise.resolve().then(() => {
          // Entry will be refreshed on next actual miss
          cache.delete(key);
        });
        return;
      }

      cache.delete(key);
    }

    res.setHeader("X-Cache", "MISS");

    const origJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      const bodyStr = JSON.stringify(body);
      const headers: Record<string, string> = {};
      const ct = res.getHeader("content-type");
      if (ct) headers["content-type"] = String(ct);

      evictOldest();
      cache.set(key, {
        body: bodyStr,
        status: res.statusCode,
        headers,
        createdAt: Date.now(),
        ttlMs,
      });

      return origJson(body);
    }) as Response["json"];

    next();
  };
}
