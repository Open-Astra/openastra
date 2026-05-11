import type { Request, Response, NextFunction } from "express";

// ── Request Timeout Middleware ───────────────────────────────────────
// Enforces a hard timeout on every request. If the handler hasn't
// responded within timeoutMs:
//   - Headers not yet sent → 504 JSON (upstream agent/LLM is hung)
//   - Headers already sent (SSE stream) → closes the connection
//
// The timer is always cleared on response finish/close to prevent leaks.

export function requestTimeout(timeoutMs = 120_000) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    const timer = setTimeout(() => {
      if (res.headersSent) {
        // Streaming response already started (SSE) — close the pipe
        res.end();
      } else {
        res.status(504).json({ error: "Request timeout", code: "GATEWAY_TIMEOUT" });
      }
    }, timeoutMs);

    res.on("finish", () => clearTimeout(timer));
    res.on("close", () => clearTimeout(timer));

    next();
  };
}
