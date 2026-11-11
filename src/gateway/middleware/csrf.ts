import type { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";

// ── CSRF Protection Middleware ──────────────────────────────────────
// Double-submit cookie pattern: the server sets a random CSRF token in
// a cookie, and the client must echo it back in the X-CSRF-Token header
// on every state-changing request (POST, PUT, PATCH, DELETE).
//
// This is stateless — no server-side token store needed. The cookie is
// SameSite=Strict + HttpOnly=false (client JS must read it), and the
// header must match the cookie value exactly.
//
// Safe methods (GET, HEAD, OPTIONS) are always allowed through.

const CSRF_COOKIE = "csrf_token";
const CSRF_HEADER = "x-csrf-token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Token length in bytes (32 bytes = 64 hex chars)
const TOKEN_BYTES = 32;

// Credential-in-body endpoints. They establish a session rather than act on
// one — there is no ambient authority for a cross-site request to abuse —
// and a first-time client has no CSRF cookie yet, so enforcing the check
// here only made the first login/registration fail with 403.
const EXEMPT_PATHS = new Set(["/auth/login", "/auth/register", "/auth/refresh"]);

function tokensMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function csrfProtection() {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Ensure a CSRF token cookie exists — generate one if missing
    let cookieToken = req.cookies?.[CSRF_COOKIE] as string | undefined;

    if (!cookieToken) {
      cookieToken = crypto.randomBytes(TOKEN_BYTES).toString("hex");
      res.cookie(CSRF_COOKIE, cookieToken, {
        httpOnly: false, // client JS must be able to read it
        sameSite: "strict",
        secure: process.env.NODE_ENV === "production",
        path: "/",
      });
    }

    // Safe methods skip validation
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    if (EXEMPT_PATHS.has(req.path)) {
      next();
      return;
    }

    // Requests authenticated by an explicit header are exempt: a browser
    // never attaches Authorization or X-Api-Key to a cross-site request on
    // its own, so they cannot be forged. Every authenticated route in the
    // gateway uses header credentials (there is no cookie session); a
    // bogus header value is simply rejected by that route's auth check.
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ") || req.headers["x-api-key"]) {
      next();
      return;
    }

    // State-changing request without Bearer auth — validate CSRF token
    const headerToken = req.headers[CSRF_HEADER] as string | undefined;

    if (!headerToken || !cookieToken || !tokensMatch(headerToken, cookieToken)) {
      res.status(403).json({
        error: "CSRF token validation failed",
        hint: `Read the "${CSRF_COOKIE}" cookie and send it as the "${CSRF_HEADER}" header.`,
      });
      return;
    }

    next();
  };
}
