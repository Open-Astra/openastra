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

    // API clients using Bearer tokens are exempt — CSRF targets browser
    // sessions with cookies, not stateless API key/JWT auth.
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      next();
      return;
    }

    // State-changing request without Bearer auth — validate CSRF token
    const headerToken = req.headers[CSRF_HEADER] as string | undefined;

    if (!headerToken || !cookieToken || headerToken !== cookieToken) {
      res.status(403).json({
        error: "CSRF token validation failed",
        hint: `Read the "${CSRF_COOKIE}" cookie and send it as the "${CSRF_HEADER}" header.`,
      });
      return;
    }

    next();
  };
}
