// ── Brute-Force Protection Middleware ────────────────────────────────
// Tracks failed login attempts per IP using an in-memory Map with TTL cleanup.
// After 5 failed attempts in 15 minutes: progressive delay (2^n seconds, max 60s).
// After 20 failed attempts in 15 minutes: block the IP for 30 minutes.
// Always returns generic "Invalid credentials" — never reveals which field was wrong.

import type { Request, Response, NextFunction } from "express";
import { getPool } from "../../config/postgres.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("brute-force");

// ── Configuration ────────────────────────────────────────────────────

const WINDOW_MS = 15 * 60 * 1000;         // 15-minute sliding window
const DELAY_THRESHOLD = 5;                 // Failed attempts before progressive delay
const BLOCK_THRESHOLD = 20;                // Failed attempts before full block
const BLOCK_DURATION_MS = 30 * 60 * 1000;  // 30-minute block
const MAX_DELAY_S = 60;                    // Max progressive delay in seconds

// ── In-Memory Store ──────────────────────────────────────────────────

interface AttemptRecord {
  failures: number[];    // timestamps of failed attempts
  blockedUntil?: number; // epoch ms when block expires
}

const store = new Map<string, AttemptRecord>();

// Cleanup stale entries every 5 minutes
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  for (const [ip, record] of store) {
    // Remove expired failures
    record.failures = record.failures.filter((ts) => ts > cutoff);
    // Remove block if expired
    if (record.blockedUntil && record.blockedUntil < now) {
      record.blockedUntil = undefined;
    }
    // Delete empty records
    if (record.failures.length === 0 && !record.blockedUntil) {
      store.delete(ip);
    }
  }
}, 5 * 60_000);
cleanupInterval.unref();

// ── Helpers ──────────────────────────────────────────────────────────

function getClientIp(req: Request): string {
  // req.ip is normalized by Express using the trust proxy setting.
  // Requires `app.set("trust proxy", 1)` when running behind a reverse proxy.
  // Do NOT read X-Forwarded-For directly — it is trivially spoofable.
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

function getRecord(ip: string): AttemptRecord {
  let record = store.get(ip);
  if (!record) {
    record = { failures: [] };
    store.set(ip, record);
  }
  return record;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Record a failed login attempt for the given IP.
 * Also persists to login_attempts table for audit trail.
 */
export async function recordFailedAttempt(ip: string): Promise<void> {
  const record = getRecord(ip);
  const now = Date.now();
  record.failures.push(now);

  // Prune old failures outside the window
  const cutoff = now - WINDOW_MS;
  record.failures = record.failures.filter((ts) => ts > cutoff);

  // Block IP if threshold exceeded
  if (record.failures.length >= BLOCK_THRESHOLD) {
    record.blockedUntil = now + BLOCK_DURATION_MS;
    log.warn(`IP ${ip} blocked for 30 minutes after ${record.failures.length} failed attempts`);
  }

  // Persist to DB (fire-and-forget)
  try {
    const pool = getPool();
    await pool.query(
      "INSERT INTO login_attempts (ip, success) VALUES ($1, false)",
      [ip],
    );
  } catch (err) {
    log.error("Failed to persist login attempt:", err);
  }
}

/**
 * Record a successful login attempt for the given IP.
 * Clears the failure counter for that IP.
 */
export async function recordSuccessfulAttempt(ip: string): Promise<void> {
  store.delete(ip);

  // Persist to DB (fire-and-forget)
  try {
    const pool = getPool();
    await pool.query(
      "INSERT INTO login_attempts (ip, success) VALUES ($1, true)",
      [ip],
    );
  } catch (err) {
    log.error("Failed to persist login attempt:", err);
  }
}

/**
 * Get the client IP from a request (for use in route handlers).
 */
export { getClientIp };

/**
 * Express middleware that enforces brute-force protection on login routes.
 * Must be applied before the login handler.
 */
export function bruteForceProtection() {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const ip = getClientIp(req);
    const record = getRecord(ip);
    const now = Date.now();

    // Prune old failures
    const cutoff = now - WINDOW_MS;
    record.failures = record.failures.filter((ts) => ts > cutoff);

    // Check if IP is blocked
    if (record.blockedUntil && record.blockedUntil > now) {
      const retryAfterS = Math.ceil((record.blockedUntil - now) / 1000);
      res.setHeader("Retry-After", String(retryAfterS));
      res.status(429).json({
        error: "Too many failed attempts. Please try again later.",
        retryAfterSeconds: retryAfterS,
      });
      return;
    }

    // Apply progressive delay if above threshold
    const failCount = record.failures.length;
    if (failCount >= DELAY_THRESHOLD) {
      const exponent = failCount - DELAY_THRESHOLD;
      const delayS = Math.min(Math.pow(2, exponent), MAX_DELAY_S);
      log.dim(`Progressive delay: ${delayS}s for IP ${ip} (failures: ${failCount})`);
      await sleep(delayS * 1000);
    }

    next();
  };
}