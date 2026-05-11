import type { Request, Response, NextFunction, ErrorRequestHandler } from "express";
import type { AuthenticatedRequest } from "./auth.js";
import type { RequestWithId } from "./observability.js";
import { isAppError } from "../errors.js";
// ── Error Classifier Middleware ────────────────────────────────────
// Enhanced error handler that:
//   1. Categorizes errors (validation, auth, rate-limit, upstream, internal)
//   2. Emits structured events to the EventBus for audit/alerting
//   3. Provides retry hints to clients via Retry-After header
//   4. Returns consistent error envelope with correlation ID

export interface ClassifiedError {
  category: "validation" | "authentication" | "authorization" | "rate_limit" | "upstream" | "not_found" | "conflict" | "internal";
  retryable: boolean;
  retryAfterMs?: number;
}

function classifyError(err: Error, status: number): ClassifiedError {
  if (status === 400) return { category: "validation", retryable: false };
  if (status === 401) return { category: "authentication", retryable: false };
  if (status === 403) return { category: "authorization", retryable: false };
  if (status === 404) return { category: "not_found", retryable: false };
  if (status === 409) return { category: "conflict", retryable: true, retryAfterMs: 1000 };
  if (status === 429) return { category: "rate_limit", retryable: true, retryAfterMs: 60_000 };

  const msg = err.message.toLowerCase();
  if (msg.includes("timeout") || msg.includes("econnrefused") || msg.includes("enotfound")) {
    return { category: "upstream", retryable: true, retryAfterMs: 5000 };
  }
  if (msg.includes("rate limit") || msg.includes("quota")) {
    return { category: "rate_limit", retryable: true, retryAfterMs: 30_000 };
  }

  return { category: "internal", retryable: false };
}

export function errorClassifier(): ErrorRequestHandler {
  return (err: Error, req: Request, res: Response, _next: NextFunction): void => {
    const uid = (req as AuthenticatedRequest).uid;
    const requestId = (req as RequestWithId).requestId;
    const status = isAppError(err) ? err.status : 500;
    const code = isAppError(err) ? err.code : "INTERNAL_ERROR";
    const classification = classifyError(err, status);

    // Log server errors and upstream failures as structured events
    if (status >= 500 || classification.category === "upstream") {
      const logPayload = {
        timestamp: new Date().toISOString(),
        requestId,
        method: req.method,
        path: req.originalUrl,
        status,
        error: err.message,
        errorCode: code,
        category: classification.category,
        uid,
      };
      console.error(JSON.stringify(logPayload));
    }

    // Set retry hint
    if (classification.retryable && classification.retryAfterMs) {
      res.setHeader("Retry-After", Math.ceil(classification.retryAfterMs / 1000).toString());
    }

    // Structured error envelope
    const envelope: Record<string, unknown> = {
      error: status >= 500 ? "Internal server error" : err.message,
      code,
      status,
      category: classification.category,
      retryable: classification.retryable,
    };

    if (requestId) envelope.requestId = requestId;

    if (isAppError(err) && err.details) {
      envelope.details = err.details;
    }

    res.status(status).json(envelope);
  };
}

// ── Async Handler Wrapper ──────────────────────────────────────────
// Wraps async route handlers to automatically catch rejected promises
// and forward them to the error middleware.

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

export function asyncHandler(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

// ── Not Found Handler ──────────────────────────────────────────────
// Catch-all for unmatched routes. Mount after all routers.

export function notFoundHandler() {
  return (req: Request, res: Response): void => {
    res.status(404).json({
      error: "Not found",
      code: "NOT_FOUND",
      status: 404,
      category: "not_found",
      retryable: false,
      path: req.originalUrl,
    });
  };
}
