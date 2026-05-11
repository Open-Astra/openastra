// ── Whisper-Chain Propagation ──────────────────────────────────────────
// Carry X-Agent-Whisper hints across the full agent spawn tree.
// Each spawned sub-agent receives the parent's whisper, building a chain.

import { getPool } from "../config/postgres.js";
import { randomUUID } from "node:crypto";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("whisper-chain");

export interface WhisperChainEntry {
  id: string;
  rootSessionId: string;
  sessionId: string;
  parentSessionId: string | null;
  depth: number;
  whisper: string;
  agentId: string;
  createdAt: Date;
}

/** Record a whisper for a session in the propagation chain. */
export async function recordWhisper(
  rootSessionId: string,
  sessionId: string,
  whisper: string,
  agentId: string,
  parentSessionId?: string,
  depth = 0,
): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO whisper_chain_log
         (id, root_session_id, session_id, parent_session_id, depth, whisper, agent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING`,
      [randomUUID(), rootSessionId, sessionId, parentSessionId ?? null, depth, whisper, agentId],
    );
  } catch (err) {
    logger.warn(`Failed to record whisper: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Get the full whisper chain for a root session. */
export async function getWhisperChain(rootSessionId: string): Promise<WhisperChainEntry[]> {
  const { rows } = await getPool().query<WhisperChainEntry>(
    `SELECT id, root_session_id AS "rootSessionId", session_id AS "sessionId",
            parent_session_id AS "parentSessionId", depth, whisper, agent_id AS "agentId",
            created_at AS "createdAt"
     FROM whisper_chain_log
     WHERE root_session_id = $1
     ORDER BY depth ASC, created_at ASC`,
    [rootSessionId],
  );
  return rows;
}

/** Build the propagated whisper for a spawned session from its parent's whisper. */
export function propagateWhisper(
  parentWhisper: string,
  childContext: string,
  depth: number,
): string {
  if (depth >= 3) return parentWhisper; // Max depth — stop appending
  return `${parentWhisper}\n[depth:${depth}] ${childContext}`.slice(0, 1000);
}

/** Extract whisper from request header, propagate from parent context. */
export function buildChildWhisper(
  incomingHeader: string | undefined,
  parentWhisper: string | undefined,
  depth: number,
): string | undefined {
  const base = parentWhisper ?? incomingHeader;
  if (!base) return incomingHeader;
  if (incomingHeader && incomingHeader !== parentWhisper) {
    return propagateWhisper(base, incomingHeader, depth);
  }
  return base;
}

/** Get most recent whisper for a session. */
export async function getSessionWhisper(sessionId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ whisper: string }>(
    `SELECT whisper FROM whisper_chain_log
     WHERE session_id = $1
     ORDER BY created_at DESC LIMIT 1`,
    [sessionId],
  );
  return rows[0]?.whisper ?? null;
}
