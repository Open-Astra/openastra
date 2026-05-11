// ── Structured Error Types ─────────────────────────────────────────
// Domain-specific error classes with error codes. Each error serializes
// to a consistent JSON shape so clients can programmatically handle
// different failure modes:
//
//   { error: string, code: string, status: number, details?: unknown }
//
// Usage in route handlers:
//   throw new AuthError("Token expired", "AUTH_TOKEN_EXPIRED");
//   throw new ValidationError("Invalid email", details);
//   throw new NotFoundError("Agent", agentId);

export interface ErrorResponse {
  error: string;
  code: string;
  status: number;
  details?: unknown;
}

// ── Base Error ─────────────────────────────────────────────────────

export class AppError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly details?: unknown;

  constructor(message: string, code: string, status: number, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }

  toJSON(): ErrorResponse {
    return {
      error: this.message,
      code: this.code,
      status: this.status,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

// ── Authentication Errors ──────────────────────────────────────────

export class AuthError extends AppError {
  constructor(message: string, code = "AUTH_ERROR") {
    super(message, code, 401);
    this.name = "AuthError";
  }
}

// ── Authorization / Forbidden ──────────────────────────────────────

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden", code = "FORBIDDEN") {
    super(message, code, 403);
    this.name = "ForbiddenError";
  }
}

// ── Validation Errors ──────────────────────────────────────────────

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, "VALIDATION_ERROR", 400, details);
    this.name = "ValidationError";
  }
}

// ── Not Found Errors ───────────────────────────────────────────────

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    const msg = id ? `${resource} "${id}" not found` : `${resource} not found`;
    super(msg, "NOT_FOUND", 404);
    this.name = "NotFoundError";
  }
}

// ── Conflict Errors ────────────────────────────────────────────────

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, "CONFLICT", 409);
    this.name = "ConflictError";
  }
}

// ── Rate Limit Errors ──────────────────────────────────────────────

export class RateLimitError extends AppError {
  public readonly retryAfterMs: number;

  constructor(retryAfterMs: number, message = "Rate limit exceeded") {
    super(message, "RATE_LIMIT_EXCEEDED", 429, { retryAfterMs });
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

// ── Agent Errors ───────────────────────────────────────────────────

export class AgentError extends AppError {
  constructor(message: string, code = "AGENT_ERROR") {
    super(message, code, 500);
    this.name = "AgentError";
  }
}

// ── Tool Errors ────────────────────────────────────────────────────

export class ToolError extends AppError {
  constructor(toolName: string, message: string) {
    super(`Tool "${toolName}": ${message}`, "TOOL_ERROR", 500);
    this.name = "ToolError";
  }
}

// ── Quota / Budget Errors ──────────────────────────────────────────

export class QuotaExceededError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, "QUOTA_EXCEEDED", 429, details);
    this.name = "QuotaExceededError";
  }
}

// ── Inference Provider Errors ──────────────────────────────────────

export class InferenceError extends AppError {
  constructor(provider: string, message: string) {
    super(`[${provider}] ${message}`, "INFERENCE_ERROR", 502);
    this.name = "InferenceError";
  }
}

// ── Configuration Errors ───────────────────────────────────────────

export class ConfigError extends AppError {
  constructor(message: string) {
    super(message, "CONFIG_ERROR", 500);
    this.name = "ConfigError";
  }
}

// ── Helper: Check if error is AppError ─────────────────────────────

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
