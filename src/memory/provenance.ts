// ── Memory Provenance ──────────────────────────────────────────────────
// Track where each memory entry originated (session, tool, agent).

import { getPool } from "../config/postgres.js";
import { randomUUID } from "node:crypto";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("memory-provenance");

export type ProvenanceSource = "conversation" | "tool" | "document" | "synthesis" | "import";

export interface ProvenanceRecord {
  id: string;
  workspaceId: string;
  memoryId: string;
  memoryTable: string;
  source: ProvenanceSource;
  sessionId: string | null;
  agentId: string | null;
  toolName: string | null;
  documentRef: string | null;
  confidence: number;
  createdAt: Date;
}

export async function recordProvenance(
  workspaceId: string,
  memoryId: string,
  memoryTable: string,
  source: ProvenanceSource,
  opts: {
    sessionId?: string;
    agentId?: string;
    toolName?: string;
    documentRef?: string;
    confidence?: number;
  } = {},
): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO memory_provenance_log
         (id, workspace_id, memory_id, memory_table, source,
          session_id, agent_id, tool_name, document_ref, confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT DO NOTHING`,
      [
        randomUUID(), workspaceId, memoryId, memoryTable, source,
        opts.sessionId ?? null, opts.agentId ?? null,
        opts.toolName ?? null, opts.documentRef ?? null,
        opts.confidence ?? 1.0,
      ],
    );
  } catch (err) {
    logger.warn(`Failed to record provenance: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function getProvenance(
  workspaceId: string,
  memoryId: string,
  memoryTable: string,
): Promise<ProvenanceRecord[]> {
  const { rows } = await getPool().query<ProvenanceRecord>(
    `SELECT id, workspace_id AS "workspaceId", memory_id AS "memoryId",
            memory_table AS "memoryTable", source, session_id AS "sessionId",
            agent_id AS "agentId", tool_name AS "toolName",
            document_ref AS "documentRef", confidence, created_at AS "createdAt"
     FROM memory_provenance_log
     WHERE workspace_id = $1 AND memory_id = $2 AND memory_table = $3
     ORDER BY created_at ASC`,
    [workspaceId, memoryId, memoryTable],
  );
  return rows;
}

export async function getProvenanceBySession(
  workspaceId: string,
  sessionId: string,
  limit = 100,
): Promise<ProvenanceRecord[]> {
  const { rows } = await getPool().query<ProvenanceRecord>(
    `SELECT id, workspace_id AS "workspaceId", memory_id AS "memoryId",
            memory_table AS "memoryTable", source, session_id AS "sessionId",
            agent_id AS "agentId", tool_name AS "toolName",
            document_ref AS "documentRef", confidence, created_at AS "createdAt"
     FROM memory_provenance_log
     WHERE workspace_id = $1 AND session_id = $2
     ORDER BY created_at DESC LIMIT $3`,
    [workspaceId, sessionId, limit],
  );
  return rows;
}

export async function getProvenanceSummary(
  workspaceId: string,
  windowDays = 7,
): Promise<Array<{ source: string; count: number; avgConfidence: number }>> {
  const { rows } = await getPool().query(
    `SELECT source,
            COUNT(*) AS count,
            AVG(confidence) AS "avgConfidence"
     FROM memory_provenance_log
     WHERE workspace_id = $1
       AND created_at > NOW() - INTERVAL '1 day' * $2
     GROUP BY source
     ORDER BY count DESC`,
    [workspaceId, windowDays],
  );
  return rows as Array<{ source: string; count: number; avgConfidence: number }>;
}

logger.info("Memory provenance module loaded");
