import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { createLogger } from "../../utils/logger.js";

// ── Platform Admin Gate ─────────────────────────────────────────────
// Platform-global operations (anything that affects every tenant, or that
// executes code on the host) are not covered by workspace roles. They
// require the operator's INTERNAL_API_KEY in the X-Api-Key header.
// Fails closed when the key is not configured.

const log = createLogger("platform-admin");

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try {
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

/** Constant-time comparison of two secrets. Returns false if either is empty. */
export function secretsMatch(provided: string | undefined, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  return safeEqual(provided, expected);
}

/** True when the request carries a valid INTERNAL_API_KEY in X-Api-Key. */
export function isPlatformAdmin(req: Request): boolean {
  const header = req.headers["x-api-key"];
  const provided = Array.isArray(header) ? header[0] : header;
  if (!provided) return false;

  const current = process.env.INTERNAL_API_KEY;
  const previous = process.env.INTERNAL_API_KEY_PREV;
  return secretsMatch(provided, current) || secretsMatch(provided, previous);
}

/** Middleware: reject unless the request carries the platform admin key. */
export function platformAdmin(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!process.env.INTERNAL_API_KEY) {
      log.error("INTERNAL_API_KEY not configured — platform admin route refused");
      res.status(503).json({ error: "Platform admin key not configured" });
      return;
    }
    if (!isPlatformAdmin(req)) {
      res.status(403).json({ error: "Platform admin key required (X-Api-Key)" });
      return;
    }
    next();
  };
}
