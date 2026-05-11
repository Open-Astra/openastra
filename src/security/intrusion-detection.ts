// ── Intrusion Detection ────────────────────────────────────────────
// Tracks suspicious patterns across requests and triggers alerts
// when thresholds are breached. Integrates with the event bus for
// audit logging and the security webhook for real-time alerting.
//
// Detection categories:
//   - SSRF attempts (blocked outbound requests)
//   - SQL injection attempts (forbidden patterns in queries)
//   - Path traversal attempts (null bytes, ../ sequences)
//   - Auth failures (brute-force, token replay)
//   - Rate limit breaches (excessive request volume)

import { getEventBus } from "../events/index.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("intrusion-detection");

// ── Types ────────────────────────────────────────────────────────────

type ThreatCategory =
  | "ssrf"
  | "sqli"
  | "path_traversal"
  | "auth_failure"
  | "rate_limit"
  | "sandbox_escape"
  | "pii_exfil";

interface ThreatEvent {
  category: ThreatCategory;
  sourceIp: string;
  uid?: string;
  detail: string;
  timestamp: number;
}

interface ThreatCounter {
  count: number;
  firstSeen: number;
  lastSeen: number;
  escalated: boolean;
}

// ── Configuration ────────────────────────────────────────────────────

/** Threats per source within the window trigger an alert. */
const THRESHOLDS: Record<ThreatCategory, number> = {
  ssrf: 5,
  sqli: 3,
  path_traversal: 5,
  auth_failure: 10,
  rate_limit: 20,
  sandbox_escape: 1,
  pii_exfil: 3,
};

/** Sliding window in milliseconds (default 10 minutes). */
const WINDOW_MS = 10 * 60 * 1000;

/** Cleanup interval (every 5 minutes). */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

// ── State ────────────────────────────────────────────────────────────

// Key: `${category}:${sourceIp}` → counter
const counters = new Map<string, ThreatCounter>();
let cleanupTimer: ReturnType<typeof setInterval> | undefined;

// ── Core Logic ───────────────────────────────────────────────────────

/**
 * Record a suspicious event. If the threshold for this category+source
 * is breached within the sliding window, emit a security alert.
 */
export function recordThreat(event: ThreatEvent): void {
  const key = `${event.category}:${event.sourceIp}`;
  const now = event.timestamp || Date.now();

  let counter = counters.get(key);
  if (!counter || now - counter.firstSeen > WINDOW_MS) {
    // Start a new window
    counter = { count: 0, firstSeen: now, lastSeen: now, escalated: false };
    counters.set(key, counter);
  }

  counter.count++;
  counter.lastSeen = now;

  const threshold = THRESHOLDS[event.category];

  if (counter.count >= threshold && !counter.escalated) {
    counter.escalated = true;
    escalate(event, counter);
  }
}

/**
 * Emit a security alert when a threshold is breached.
 */
function escalate(event: ThreatEvent, counter: ThreatCounter): void {
  logger.error(
    `ALERT: ${event.category} threshold breached`,
    `ip=${event.sourceIp} count=${counter.count} uid=${event.uid ?? "unknown"}`,
  );

  try {
    const bus = getEventBus();
    bus.emit("security.intrusion_detected", {
      category: event.category,
      sourceIp: event.sourceIp,
      uid: event.uid,
      count: counter.count,
      windowMs: WINDOW_MS,
      detail: event.detail,
      severity: getSeverityForCategory(event.category),
    });
  } catch {
    // Event bus may not be initialized during early startup
  }

  // Fire webhook for critical threats
  fireWebhook(event, counter).catch(() => {});
}

function getSeverityForCategory(category: ThreatCategory): string {
  switch (category) {
    case "sandbox_escape":
    case "ssrf":
    case "sqli":
      return "critical";
    case "auth_failure":
    case "pii_exfil":
      return "high";
    case "path_traversal":
    case "rate_limit":
      return "medium";
    default:
      return "low";
  }
}

async function fireWebhook(event: ThreatEvent, counter: ThreatCounter): Promise<void> {
  const webhookUrl = process.env.SECURITY_WEBHOOK_URL;
  if (!webhookUrl) return;

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        event: "security.intrusion_detected",
        severity: getSeverityForCategory(event.category),
        details: {
          category: event.category,
          sourceIp: event.sourceIp,
          uid: event.uid,
          count: counter.count,
          detail: event.detail,
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Fire-and-forget
  }
}

// ── Cleanup ──────────────────────────────────────────────────────────

function cleanup(): void {
  const now = Date.now();
  for (const [key, counter] of counters) {
    if (now - counter.lastSeen > WINDOW_MS) {
      counters.delete(key);
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Start the intrusion detection system.
 * Call once during gateway startup.
 */
export function initIntrusionDetection(): void {
  cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS);
  // Unref so the timer doesn't prevent graceful shutdown
  if (typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
    cleanupTimer.unref();
  }
  logger.active("intrusion detection", "started");
}

/**
 * Stop the intrusion detection system.
 * Call during graceful shutdown.
 */
export function stopIntrusionDetection(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = undefined;
  }
  counters.clear();
}

/**
 * Get current threat counters (for diagnostics endpoint).
 */
export function getThreatSummary(): Record<string, { count: number; escalated: boolean }> {
  const summary: Record<string, { count: number; escalated: boolean }> = {};
  for (const [key, counter] of counters) {
    summary[key] = { count: counter.count, escalated: counter.escalated };
  }
  return summary;
}
