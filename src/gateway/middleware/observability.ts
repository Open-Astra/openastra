import { randomUUID } from "crypto";
import type { Request, Response, NextFunction, ErrorRequestHandler } from "express";
import type { AuthenticatedRequest } from "./auth.js";
import { isAppError } from "../errors.js";

// ── Correlation ID ───────────────────────────────────────────────────

export interface RequestWithId extends Request {
  requestId: string;
}

// Reads X-Request-ID from incoming headers or generates a UUID.
// Echoes the ID back in the response so clients can correlate errors.
export function correlationId() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const id = (req.headers["x-request-id"] as string | undefined) || randomUUID();
    (req as RequestWithId).requestId = id;
    res.setHeader("X-Request-ID", id);
    next();
  };
}

// ── Structured Log Entry ────────────────────────────────────────────

interface LogEntry {
  timestamp: string;
  requestId?: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  uid?: string;
  error?: string;
  errorCode?: string;
}

function writeLog(entry: LogEntry): void {
  // Structured JSON for Cloud Logging — one line per entry
  console.log(JSON.stringify(entry));
}

// ── Request Logger Middleware ────────────────────────────────────────
// Logs method, path, status, duration, and uid (if authenticated).
// Must be mounted before routes so it can capture the response finish event.

export function requestLogger() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = Date.now();

    res.on("finish", () => {
      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        requestId: (req as RequestWithId).requestId,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Date.now() - start,
      };

      const uid = (req as AuthenticatedRequest).uid;
      if (uid) entry.uid = uid;

      writeLog(entry);
    });

    next();
  };
}

// ── Error Handler Middleware ─────────────────────────────────────────
// Must be the last middleware. Catches unhandled errors, logs them as
// structured JSON, and returns structured error responses.
//
// If the error is an AppError (structured), returns its code, status,
// and details. Otherwise, returns a generic 500.

export function errorHandler(): ErrorRequestHandler {
  return (err: Error, req: Request, res: Response, _next: NextFunction): void => {
    const uid = (req as AuthenticatedRequest).uid;

    const requestId = (req as RequestWithId).requestId;

    if (isAppError(err)) {
      // Structured domain error — return full details to the client
      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        requestId,
        method: req.method,
        path: req.originalUrl,
        status: err.status,
        durationMs: 0,
        error: err.message,
        errorCode: err.code,
      };
      if (uid) entry.uid = uid;
      writeLog(entry);

      res.status(err.status).json(err.toJSON());
      return;
    }

    // Unstructured error — log full details, return generic 500
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      requestId,
      method: req.method,
      path: req.originalUrl,
      status: 500,
      durationMs: 0,
      error: err.message || "Unknown error",
    };
    if (uid) entry.uid = uid;
    writeLog(entry);

    res.status(500).json({
      error: "Internal server error",
      code: "INTERNAL_ERROR",
      status: 500,
    });
  };
}
