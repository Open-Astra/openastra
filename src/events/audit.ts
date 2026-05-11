// ── Audit Logger ────────────────────────────────────────────────────
// Subscribes to sensitive event bus events and writes them to the
// audit_log table for compliance and security observability.
// Fire-and-forget: errors are logged but never thrown.

import { createHash } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { getEventBus } from "./index.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("audit");

// Maximum byte length before we hash a payload value instead of storing raw
const MAX_PAYLOAD_LENGTH = 500;

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Hash a string with SHA-256 and return the first 16 hex characters.
 * Used to fingerprint large payloads without storing raw content.
 */
function sha256Short(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * Sanitize a metadata value so oversized strings are replaced with
 * a hash fingerprint rather than stored verbatim.
 */
function sanitizeMetadata(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && value.length > MAX_PAYLOAD_LENGTH) {
      out[key] = `[sha256:${sha256Short(value)}***]`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Write a single row to audit_log.  Never throws — errors are logged
 * to stderr and silently swallowed so callers are unaffected.
 */
async function writeAuditRow(
  event: string,
  uid: string,
  sessionId: string | undefined,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    const pool = getPool();
    const sanitized = sanitizeMetadata(metadata);
    await pool.query(
      `INSERT INTO audit_log (event, uid, user_id, agent_id, action, session_id, details, metadata, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)`,
      [event, uid, uid, metadata.agentId ?? "system", event, sessionId ?? null,
       JSON.stringify(sanitized), JSON.stringify(sanitized), Date.now()],
    );
  } catch (err) {
    logger.error("Failed to write audit row:", err);
  }
}

// ── Subscription Handlers ────────────────────────────────────────────

function handleToolExecuted(payload: unknown): void {
  const p = payload as {
    uid?: string;
    sessionId?: string;
    toolName?: string;
    durationMs?: number;
    error?: string;
  };

  const uid = p.uid ?? "unknown";
  const metadata: Record<string, unknown> = {
    toolName: p.toolName ?? "",
    durationMs: p.durationMs ?? 0,
  };
  if (p.error) metadata.error = p.error;

  writeAuditRow("tool.executed", uid, p.sessionId, metadata).catch(() => {});
}

function handleMemoryWritten(payload: unknown): void {
  const p = payload as {
    uid?: string;
    category?: string;
    content?: string;
    timestamp?: number;
  };

  const uid = p.uid ?? "unknown";
  const metadata: Record<string, unknown> = {
    category: p.category ?? "",
    contentLength: typeof p.content === "string" ? p.content.length : 0,
  };

  writeAuditRow("memory.written", uid, undefined, metadata).catch(() => {});
}

function handleAgentSpawnStarted(payload: unknown): void {
  const p = payload as {
    uid?: string;
    taskId?: string;
    parentAgentId?: string;
    targetAgentId?: string;
    depth?: number;
  };

  const uid = p.uid ?? "unknown";
  const metadata: Record<string, unknown> = {
    parentId: p.parentAgentId ?? "",
    targetId: p.targetAgentId ?? "",
    depth: p.depth ?? 0,
    taskId: p.taskId ?? "",
  };

  writeAuditRow("agent.spawned", uid, undefined, metadata).catch(() => {});
}

function handleInferenceRequest(payload: unknown): void {
  const p = payload as {
    uid?: string;
    sessionId?: string;
    provider?: string;
    modelId?: string;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    durationMs?: number;
  };

  const uid = p.uid ?? "unknown";
  const metadata: Record<string, unknown> = {
    provider: p.provider ?? "",
    modelId: p.modelId ?? "",
    promptTokens: p.promptTokens ?? 0,
    completionTokens: p.completionTokens ?? 0,
    totalTokens: p.totalTokens ?? 0,
    durationMs: p.durationMs ?? 0,
  };

  writeAuditRow("inference.request", uid, p.sessionId, metadata).catch(() => {});
}

function handleSecurityTokenReplay(payload: unknown): void {
  const p = payload as {
    uid?: string;
    jti?: string;
    tokenFamily?: string;
    ip?: string;
    severity?: string;
  };

  const uid = p.uid ?? "unknown";
  const event = "security.token_replay";
  const severity = getSeverity(event);
  const metadata: Record<string, unknown> = {
    jti: p.jti ?? "",
    tokenFamily: p.tokenFamily ?? "",
    ip: p.ip ?? "",
    severity,
  };

  writeAuditRow(event, uid, undefined, metadata).catch(() => {});
  fireSecurityWebhook(event, severity, metadata).catch(() => {});
}

function handleSecurityTokenRevoked(payload: unknown): void {
  const p = payload as {
    uid?: string;
    jti?: string;
    revokedBy?: string;
  };

  const uid = p.uid ?? "unknown";
  const metadata: Record<string, unknown> = {
    jti: p.jti ?? "",
    revokedBy: p.revokedBy ?? "",
  };

  writeAuditRow("security.token_revoked", uid, undefined, metadata).catch(() => {});
}

// ── Security Severity Classification ────────────────────────────────
// Maps event types to severity levels for alerting and prioritization.

type SecuritySeverity = "critical" | "high" | "medium" | "low";

const SEVERITY_MAP: Record<string, SecuritySeverity> = {
  "security.token_replay": "critical",
  "security.ssrf_blocked": "critical",
  "security.sandbox_escape": "critical",
  "security.auth_bypass": "critical",
  "security.brute_force": "high",
  "security.rate_limit": "high",
  "security.forbidden_sql": "high",
  "security.token_revoked": "medium",
  "security.pii_detected": "medium",
  "security.webhook_signature_mismatch": "medium",
  "security.expired_token": "medium",
  "security.intrusion_detected": "critical",
  "tool.executed": "low",
  "memory.written": "low",
  "inference.request": "low",
  "agent.spawn.started": "low",
};

function getSeverity(event: string): SecuritySeverity {
  return SEVERITY_MAP[event] ?? "low";
}

// ── Security Webhook Alerting ───────────────────────────────────────
// Fire-and-forget POST to SECURITY_WEBHOOK_URL for critical/high events.

async function fireSecurityWebhook(
  event: string,
  severity: SecuritySeverity,
  metadata: Record<string, unknown>,
): Promise<void> {
  const webhookUrl = process.env.SECURITY_WEBHOOK_URL;
  if (!webhookUrl) return;
  if (severity !== "critical" && severity !== "high") return;

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        event,
        severity,
        details: metadata,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Fire-and-forget — don't let webhook failures affect the system
  }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Subscribe the audit logger to the event bus.
 * Should be called once during gateway startup after the event bus is ready.
 */
export function initAuditLogger(): void {
  const bus = getEventBus();

  bus.on("tool.executed", handleToolExecuted as Parameters<typeof bus.on<"tool.executed">>[1]);
  bus.on("memory.written", handleMemoryWritten as Parameters<typeof bus.on<"memory.written">>[1]);
  bus.on(
    "agent.spawn.started",
    handleAgentSpawnStarted as Parameters<typeof bus.on<"agent.spawn.started">>[1],
  );
  bus.on(
    "inference.request",
    handleInferenceRequest as Parameters<typeof bus.on<"inference.request">>[1],
  );
  bus.on(
    "security.token_replay",
    handleSecurityTokenReplay as Parameters<typeof bus.on<"security.token_replay">>[1],
  );
  bus.on(
    "security.token_revoked",
    handleSecurityTokenRevoked as Parameters<typeof bus.on<"security.token_revoked">>[1],
  );

  logger.active("audit logger", "tool.executed + memory.written + agent.spawn.started + inference.request + security.token_replay + security.token_revoked");
}
