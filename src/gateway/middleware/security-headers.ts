import type { Request, Response, NextFunction } from "express";

// ── Security Headers Middleware ─────────────────────────────────────
// Sets standard security headers on every response. Equivalent to what
// helmet.js provides, without adding a dependency.
//
// Headers applied:
//   X-Content-Type-Options: nosniff
//   X-Frame-Options: DENY
//   X-XSS-Protection: 0 (modern browsers don't need it; CSP is better)
//   Strict-Transport-Security: max-age=31536000; includeSubDomains
//   Referrer-Policy: strict-origin-when-cross-origin
//   Content-Security-Policy: default-src 'self'
//   X-Permitted-Cross-Domain-Policies: none
//   X-DNS-Prefetch-Control: off
//   X-Download-Options: noopen
//   Cross-Origin-Opener-Policy: same-origin
//   Cross-Origin-Resource-Policy: same-origin
//   Permissions-Policy: (restrictive defaults)

export function securityHeaders() {
  return (_req: Request, res: Response, next: NextFunction): void => {
    // Prevent MIME type sniffing
    res.setHeader("X-Content-Type-Options", "nosniff");

    // Prevent clickjacking — deny all framing
    res.setHeader("X-Frame-Options", "DENY");

    // Disable legacy XSS filter (causes more issues than it solves)
    res.setHeader("X-XSS-Protection", "0");

    // Enforce HTTPS for 1 year (only effective over HTTPS)
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );

    // Control referrer information
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

    // Basic CSP — restrict to self. API-only server doesn't need inline scripts.
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; frame-ancestors 'none'",
    );

    // Prevent Adobe Flash/Acrobat cross-domain requests
    res.setHeader("X-Permitted-Cross-Domain-Policies", "none");

    // Prevent DNS prefetching (privacy)
    res.setHeader("X-DNS-Prefetch-Control", "off");

    // Prevent IE from opening downloads in the site's context
    res.setHeader("X-Download-Options", "noopen");

    // Isolate browsing context (prevent cross-origin window references)
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");

    // Restrict cross-origin resource loading
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");

    // Restrict browser features (camera, mic, geolocation, etc.)
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), interest-cohort=()",
    );

    // Remove Express fingerprint header
    res.removeHeader("X-Powered-By");

    next();
  };
}
