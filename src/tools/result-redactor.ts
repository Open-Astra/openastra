// ── Tool Result Redaction ───────────────────────────────────────────
// Automatically redacts secrets and PII from tool results before:
//   1. Feeding back to LLM (prevents tool output leakage to inference)
//   2. Storing in session messages (prevents persistence of exposed secrets)
//   3. Sending via channels (prevents leakage to external platforms)
//
// Uses the same pattern + entropy scanners as secrets/scanner.ts for consistency.

import { scanContent, redactPII } from "../secrets/scanner.js";
import { createLogger } from "../utils/logger.js";
import type { ToolResult } from "./types.js";

const logger = createLogger("tool-redactor");

export interface RedactionStats {
  secretsFound: number;
  piiFound: number;
  totalRedactions: number;
}

/**
 * Redact secrets and PII from a tool result string.
 * Returns both the redacted content and stats for logging/audit.
 */
export function redactToolResult(content: string): { redacted: string; stats: RedactionStats } {
  let redacted = content;
  let secretsFound = 0;
  let piiFound = 0;

  try {
    // 1. Redact secrets (API keys, JWT, etc.)
    const secretScan = scanContent(content);
    if (secretScan.hasPotentialSecrets) {
      redacted = secretScan.sanitized;
      secretsFound = secretScan.matches;
    }

    // 2. Redact PII (email, phone, SSN, etc.)
    const piiResult = redactPII(redacted);
    if (piiResult.found.length > 0) {
      redacted = piiResult.redacted;
      piiFound = piiResult.found.length;
    }
  } catch (err) {
    logger.error("Redaction failed, returning original:", (err as Error).message);
    // Fail-closed: return original if redaction breaks
  }

  return {
    redacted,
    stats: {
      secretsFound,
      piiFound,
      totalRedactions: secretsFound + piiFound,
    },
  };
}

/**
 * Redact a ToolResult object in-place.
 * Only redacts the `content` field; metadata (name, id) untouched.
 */
export function redactToolResultObject(result: ToolResult): { result: ToolResult; stats: RedactionStats } {
  const { redacted, stats } = redactToolResult(result.content);

  if (stats.totalRedactions > 0) {
    const toolName = result.name || "unknown";
    logger.info(
      `Redacted tool result [${toolName}]: ${stats.secretsFound} secrets, ${stats.piiFound} PII items`,
    );
  }

  return {
    result: { ...result, content: redacted },
    stats,
  };
}

/**
 * Redact multiple tool results (e.g., after a tool round).
 */
export function redactToolResults(results: ToolResult[]): { results: ToolResult[]; stats: RedactionStats } {
  let totalSecrets = 0;
  let totalPii = 0;

  const redacted = results.map((r) => {
    const { result: redactedResult, stats } = redactToolResultObject(r);
    totalSecrets += stats.secretsFound;
    totalPii += stats.piiFound;
    return redactedResult;
  });

  return {
    results: redacted,
    stats: {
      secretsFound: totalSecrets,
      piiFound: totalPii,
      totalRedactions: totalSecrets + totalPii,
    },
  };
}
