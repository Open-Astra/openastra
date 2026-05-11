// ── Inference Payload Audit ──────────────────────────────────────────
// Writes full request/response payloads to inference_payloads table
// for forensic auditing. Payloads are redacted through the secret
// scanner before storage. Fire-and-forget — errors never break the
// agent loop.

import { createHash } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("payload-audit");

// ── Types ───────────────────────────────────────────────────────────

export interface InferencePayloadRecord {
  uid: string;
  agentId: string;
  sessionId: string;
  provider: string;
  modelId: string;
  requestMessages: unknown[];
  systemPromptHash?: string;
  toolSchemas?: unknown[];
  responseContent?: string;
  finishReason?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;
  durationMs?: number;
  traceId?: string;
  ttlDays?: number;
}

// ── Redaction ───────────────────────────────────────────────────────

let _redactFn: ((text: string) => string) | null = null;

async function getRedactor(): Promise<(text: string) => string> {
  if (_redactFn) return _redactFn;
  try {
    const mod = await import("../secrets/scanner.js");
    // scanContent returns { sanitized, hasPotentialSecrets, matches }
    _redactFn = (text: string) => mod.scanContent(text).sanitized;
    return _redactFn;
  } catch {
    // Scanner not available — return identity function
    _redactFn = (t: string) => t;
    return _redactFn;
  }
}

function redactValue(redact: (s: string) => string, value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(redact, v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(redact, v);
    }
    return out;
  }
  return value;
}

// ── Write ───────────────────────────────────────────────────────────

export async function writeInferencePayload(record: InferencePayloadRecord): Promise<void> {
  try {
    const pool = getPool();
    const redact = await getRedactor();

    // Redact all string content in messages
    const redactedMessages = redactValue(redact, record.requestMessages);
    const redactedResponse = record.responseContent
      ? redact(record.responseContent)
      : null;

    // Hash the system prompt (first message if role=system) for dedup
    let systemPromptHash = record.systemPromptHash;
    if (!systemPromptHash && Array.isArray(record.requestMessages) && record.requestMessages.length > 0) {
      const first = record.requestMessages[0] as { role?: string; content?: string } | undefined;
      if (first?.role === "system" && first.content) {
        systemPromptHash = createHash("sha256").update(first.content).digest("hex").slice(0, 16);
      }
    }

    const ttlDays = record.ttlDays ?? parseInt(process.env.INFERENCE_PAYLOAD_TTL_DAYS ?? "30", 10);

    await pool.query(
      `INSERT INTO inference_payloads
         (uid, agent_id, session_id, provider, model_id,
          request_messages, system_prompt_hash, tool_schemas,
          response_content, finish_reason,
          prompt_tokens, completion_tokens, total_tokens, cached_tokens,
          duration_ms, trace_id, expires_at)
       VALUES ($1, $2, $3, $4, $5,
               $6::jsonb, $7, $8::jsonb,
               $9, $10,
               $11, $12, $13, $14,
               $15, $16, NOW() + INTERVAL '1 day' * $17)`,
      [
        record.uid,
        record.agentId,
        record.sessionId,
        record.provider,
        record.modelId,
        JSON.stringify(redactedMessages),
        systemPromptHash ?? null,
        record.toolSchemas ? JSON.stringify(record.toolSchemas) : null,
        redactedResponse,
        record.finishReason ?? null,
        record.promptTokens,
        record.completionTokens,
        record.totalTokens,
        record.cachedTokens ?? 0,
        record.durationMs ?? null,
        record.traceId ?? null,
        ttlDays,
      ],
    );
  } catch (err) {
    log.error("Failed to write inference payload:", err instanceof Error ? err.message : String(err));
  }
}

// ── Cleanup ─────────────────────────────────────────────────────────

export async function cleanupExpiredPayloads(): Promise<number> {
  try {
    const pool = getPool();
    const { rowCount } = await pool.query(
      "DELETE FROM inference_payloads WHERE expires_at < NOW()",
    );
    const deleted = rowCount ?? 0;
    if (deleted > 0) {
      log.dim(`Cleaned up ${deleted} expired inference payload(s)`);
    }
    return deleted;
  } catch (err) {
    log.error("Payload cleanup error:", err instanceof Error ? err.message : String(err));
    return 0;
  }
}
