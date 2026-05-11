// ── Reflexion Loop ────────────────────────────────────────────────────
// Self-critique and revision cycle: draft → critique → revise.
// Configurable passes (1–3). Logs to reflexion_logs table.

import { getPool } from "../config/postgres.js";
import { randomUUID } from "node:crypto";
import { createLogger } from "../utils/logger.js";
import type { InferenceClient } from "../inference/types.js";

const logger = createLogger("reflexion");

export interface ReflexionResult {
  draft: string;
  critique: string | null;
  final: string;
  passes: number;
  durationMs: number;
}

const CRITIQUE_PROMPT = `Review the following response for accuracy, completeness, and clarity. Identify specific weaknesses in 2-3 sentences. Be concise and constructive.

Response:
{draft}`;

const REVISE_PROMPT = `Revise the following response based on the critique. Keep what is good, fix the identified issues. Return only the revised response.

Original response:
{draft}

Critique:
{critique}`;

export async function runReflexionLoop(
  draft: string,
  client: InferenceClient,
  passes: number = 1,
  maxTokens: number = 4096,
): Promise<ReflexionResult> {
  const start = Date.now();
  passes = Math.min(Math.max(passes, 1), 3);

  let current = draft;
  let lastCritique: string | null = null;

  for (let i = 0; i < passes; i++) {
    try {
      // Critique
      const critiqueResp = await client.chat({
        messages: [{ role: "user", content: CRITIQUE_PROMPT.replace("{draft}", current) }],
        temperature: 0.3,
        maxTokens: 512,
      });
      lastCritique = ( critiqueResp.content ?? "").trim();

      // Revise
      const reviseResp = await client.chat({
        messages: [{
          role: "user",
          content: REVISE_PROMPT
            .replace("{draft}", current)
            .replace("{critique}", lastCritique),
        }],
        temperature: 0.5,
        maxTokens,
      });
      current = ( reviseResp.content ?? "").trim();
    } catch (err) {
      logger.warn(`Reflexion pass ${i + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
  }

  return {
    draft,
    critique: lastCritique,
    final: current,
    passes,
    durationMs: Date.now() - start,
  };
}

export async function logReflexion(
  workspaceId: string,
  sessionId: string,
  agentId: string,
  turnIndex: number,
  result: ReflexionResult,
): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO reflexion_logs
         (id, workspace_id, session_id, agent_id, turn_index, passes, draft, critique, final, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        randomUUID(), workspaceId, sessionId, agentId, turnIndex,
        result.passes, result.draft, result.critique, result.final, result.durationMs,
      ],
    );
  } catch (err) {
    logger.warn(`Failed to log reflexion: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function listReflexionLogs(
  workspaceId: string,
  sessionId?: string,
  limit = 20,
): Promise<unknown[]> {
  if (sessionId) {
    const { rows } = await getPool().query(
      `SELECT id, session_id AS "sessionId", agent_id AS "agentId",
              turn_index AS "turnIndex", passes, draft, critique, final,
              duration_ms AS "durationMs", created_at AS "createdAt"
       FROM reflexion_logs
       WHERE workspace_id = $1 AND session_id = $2
       ORDER BY created_at DESC LIMIT $3`,
      [workspaceId, sessionId, limit],
    );
    return rows;
  }
  const { rows } = await getPool().query(
    `SELECT id, session_id AS "sessionId", agent_id AS "agentId",
            turn_index AS "turnIndex", passes, draft, critique, final,
            duration_ms AS "durationMs", created_at AS "createdAt"
     FROM reflexion_logs
     WHERE workspace_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [workspaceId, limit],
  );
  return rows;
}
