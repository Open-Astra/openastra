// ── WebSocket Rate Limiting ───────────────────────────────────────────
// Tracks connections per IP and messages per connection to prevent DoS.
// Phase 5.1 of security audit.

import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("ws-rate-limit");

// ── Connection Rate Limiting ────────────────────────────────────────
// Limit: 10 new connections per IP per minute

interface IpRecord {
  count: number;
  timestamps: number[];
}

const ipConnections = new Map<string, IpRecord>();

const MAX_CONNECTIONS_PER_IP_PER_MIN = 10;
const MAX_MESSAGES_PER_CONNECTION_PER_MIN = 100;
const WINDOW_MS = 60_000;

// Auto-cleanup every 60 seconds: remove entries older than 1 minute
const cleanupInterval = setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [ip, record] of ipConnections) {
    record.timestamps = record.timestamps.filter((ts) => ts > cutoff);
    record.count = record.timestamps.length;
    if (record.count === 0) {
      ipConnections.delete(ip);
    }
  }
}, WINDOW_MS);
cleanupInterval.unref();

/**
 * Extract client IP from an HTTP request (respects X-Forwarded-For behind proxy).
 */
function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0]!.trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

/**
 * Check whether a new WebSocket connection from this IP should be allowed.
 * Returns true if allowed, false if rate limited.
 */
export function checkConnectionRateLimit(req: IncomingMessage): boolean {
  const ip = getClientIp(req);
  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  let record = ipConnections.get(ip);
  if (!record) {
    record = { count: 0, timestamps: [] };
    ipConnections.set(ip, record);
  }

  // Prune old timestamps
  record.timestamps = record.timestamps.filter((ts) => ts > cutoff);
  record.count = record.timestamps.length;

  if (record.count >= MAX_CONNECTIONS_PER_IP_PER_MIN) {
    log.warn(`WS connection rate limit exceeded for IP=${ip} (${record.count}/${MAX_CONNECTIONS_PER_IP_PER_MIN})`);
    return false;
  }

  record.timestamps.push(now);
  record.count++;
  return true;
}

// ── Per-Connection Message Rate Limiting ─────────────────────────────
// Limit: 100 messages per connection per minute

interface MessageTracker {
  timestamps: number[];
}

const connectionTrackers = new WeakMap<WebSocket, MessageTracker>();

/**
 * Initialize message rate tracking for a new WebSocket connection.
 */
export function initMessageRateLimit(ws: WebSocket): void {
  connectionTrackers.set(ws, { timestamps: [] });
}

/**
 * Check whether a message on this connection should be allowed.
 * Returns true if allowed, false if rate limited.
 * When rate limited, the WebSocket is closed with code 1008 (Policy Violation).
 */
export function checkMessageRateLimit(ws: WebSocket): boolean {
  let tracker = connectionTrackers.get(ws);
  if (!tracker) {
    tracker = { timestamps: [] };
    connectionTrackers.set(ws, tracker);
  }

  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  // Prune old timestamps
  tracker.timestamps = tracker.timestamps.filter((ts) => ts > cutoff);

  if (tracker.timestamps.length >= MAX_MESSAGES_PER_CONNECTION_PER_MIN) {
    log.warn(`WS message rate limit exceeded — closing connection`);
    ws.close(1008, "Rate limit exceeded");
    return false;
  }

  tracker.timestamps.push(now);
  return true;
}
