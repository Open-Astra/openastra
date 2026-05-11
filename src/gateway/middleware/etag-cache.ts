import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";

// ── ETag Caching Middleware ────────────────────────────────────────
// Generates ETags for JSON responses and returns 304 Not Modified when
// the client's If-None-Match header matches. Reduces bandwidth for
// read-heavy endpoints like /agents and /skills that rarely change.
//
// Usage:
//   router.get("/", etagCache(), handler);
//
// Also supports a short TTL cache (optional) to avoid recomputing
// the response body on every request.

interface ETagCacheOptions {
  /** Max-age in seconds for Cache-Control header. Default: 0 (must-revalidate). */
  maxAge?: number;
}

export function etagCache(options: ETagCacheOptions = {}) {
  const maxAge = options.maxAge ?? 0;

  return (_req: Request, res: Response, next: NextFunction): void => {
    // Intercept res.json to compute ETag before sending
    const originalJson = res.json.bind(res);

    res.json = function etagJson(body: unknown): Response {
      // Serialize the response body
      const bodyStr = JSON.stringify(body);

      // Compute a weak ETag from the content hash
      const hash = crypto.createHash("md5").update(bodyStr).digest("hex");
      const etag = `W/"${hash}"`;

      // Set caching headers
      res.setHeader("ETag", etag);
      if (maxAge > 0) {
        res.setHeader("Cache-Control", `public, max-age=${maxAge}, must-revalidate`);
      } else {
        res.setHeader("Cache-Control", "no-cache, must-revalidate");
      }

      // Check If-None-Match
      const clientEtag = _req.headers["if-none-match"];
      if (clientEtag === etag) {
        res.status(304).end();
        return res;
      }

      return originalJson(body);
    } as typeof res.json;

    next();
  };
}
