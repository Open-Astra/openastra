// ── Output Post-Processor Pipeline ────────────────────────────────────
// Chainable transforms applied to agent output before returning to caller.
// Processors: redact-pii | reformat-json | truncate | translate | custom

import { getPool } from "../config/postgres.js";
import { randomUUID } from "node:crypto";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("output-processor");

export type ProcessorType = "redact-pii" | "reformat-json" | "truncate" | "translate" | "uppercase" | "lowercase";

export interface ProcessorEntry {
  id: string;
  agentId: string;
  workspaceId: string;
  position: number;
  processor: ProcessorType;
  config: Record<string, unknown>;
  enabled: boolean;
}

// PII patterns: email, phone, SSN, credit card
const PII_PATTERNS: Array<[RegExp, string]> = [
  [/\b[\w._%+-]+@[\w.-]+\.[a-z]{2,}\b/gi, "[EMAIL]"],
  [/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, "[PHONE]"],
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[SSN]"],
  [/\b(?:\d{4}[-\s]?){3}\d{4}\b/g, "[CARD]"],
];

function applyProcessor(
  text: string,
  processor: ProcessorType,
  config: Record<string, unknown>,
): string {
  switch (processor) {
    case "redact-pii": {
      let result = text;
      for (const [pattern, replacement] of PII_PATTERNS) {
        result = result.replace(pattern, replacement);
      }
      return result;
    }
    case "reformat-json": {
      try {
        const parsed = JSON.parse(text) as unknown;
        const indent = typeof config["indent"] === "number" ? config["indent"] : 2;
        return JSON.stringify(parsed, null, indent);
      } catch {
        return text; // Not valid JSON — pass through
      }
    }
    case "truncate": {
      const maxChars = typeof config["maxChars"] === "number" ? config["maxChars"] : 2000;
      const suffix = typeof config["suffix"] === "string" ? config["suffix"] : "…";
      return text.length > maxChars ? text.slice(0, maxChars) + suffix : text;
    }
    case "translate": {
      // Stub — real implementation would call a translation API
      const targetLang = config["targetLang"] as string | undefined;
      if (targetLang) {
        logger.info(`Translation to ${targetLang} requested — stub passthrough`);
      }
      return text;
    }
    case "uppercase":
      return text.toUpperCase();
    case "lowercase":
      return text.toLowerCase();
    default:
      return text;
  }
}

export function processOutput(text: string, processors: ProcessorEntry[]): string {
  const enabled = processors
    .filter((p) => p.enabled)
    .sort((a, b) => a.position - b.position);

  let result = text;
  for (const p of enabled) {
    try {
      result = applyProcessor(result, p.processor as ProcessorType, p.config);
    } catch (err) {
      logger.warn(`Processor "${p.processor}" failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

export async function getProcessors(agentId: string, workspaceId: string): Promise<ProcessorEntry[]> {
  const { rows } = await getPool().query<ProcessorEntry>(
    `SELECT id, agent_id AS "agentId", workspace_id AS "workspaceId",
            position, processor, config, enabled
     FROM output_processor_chains
     WHERE agent_id = $1 AND workspace_id = $2
     ORDER BY position ASC`,
    [agentId, workspaceId],
  );
  return rows;
}

export async function addProcessor(
  agentId: string,
  workspaceId: string,
  processor: ProcessorType,
  position: number,
  config: Record<string, unknown> = {},
): Promise<ProcessorEntry> {
  const { rows } = await getPool().query<ProcessorEntry>(
    `INSERT INTO output_processor_chains
       (id, workspace_id, agent_id, position, processor, config)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (workspace_id, agent_id, position) DO UPDATE
       SET processor = EXCLUDED.processor, config = EXCLUDED.config
     RETURNING id, agent_id AS "agentId", workspace_id AS "workspaceId",
               position, processor, config, enabled`,
    [randomUUID(), workspaceId, agentId, position, processor, JSON.stringify(config)],
  );
  return rows[0]!;
}

export async function removeProcessor(id: string, workspaceId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `DELETE FROM output_processor_chains WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return (rowCount ?? 0) > 0;
}
