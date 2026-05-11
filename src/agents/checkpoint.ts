// ── Conversation Checkpointing ─────────────────────────────────────────
// Save/restore full conversation state at any turn.

import { getPool } from "../config/postgres.js";
import { randomUUID } from "node:crypto";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("checkpoint");

export interface ConversationCheckpoint {
  id: string;
  sessionId: string;
  workspaceId: string;
  label: string | null;
  messageCount: number;
  tokenEstimate: number;
  snapshot: unknown[];
  createdBy: string | null;
  createdAt: Date;
}

export async function saveCheckpoint(
  sessionId: string,
  workspaceId: string,
  snapshot: unknown[],
  createdBy?: string,
  label?: string,
): Promise<ConversationCheckpoint> {
  const id = randomUUID();
  const tokenEstimate = snapshot.reduce((sum: number, msg) => {
    const m = msg as { content?: string };
    return sum + Math.ceil((m.content?.length ?? 0) / 4);
  }, 0);

  const { rows } = await getPool().query<ConversationCheckpoint>(
    `INSERT INTO conversation_checkpoints
       (id, workspace_id, session_id, label, message_count, token_estimate, snapshot, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
     RETURNING id, session_id AS "sessionId", workspace_id AS "workspaceId",
               label, message_count AS "messageCount", token_estimate AS "tokenEstimate",
               snapshot, created_by AS "createdBy", created_at AS "createdAt"`,
    [id, workspaceId, sessionId, label ?? null, snapshot.length, tokenEstimate,
     JSON.stringify(snapshot), createdBy ?? null],
  );
  logger.info(`Checkpoint saved for session ${sessionId} (${snapshot.length} messages)`);
  return rows[0]!;
}

export async function listCheckpoints(
  sessionId: string,
  workspaceId: string,
): Promise<Omit<ConversationCheckpoint, "snapshot">[]> {
  const { rows } = await getPool().query(
    `SELECT id, session_id AS "sessionId", workspace_id AS "workspaceId",
            label, message_count AS "messageCount", token_estimate AS "tokenEstimate",
            created_by AS "createdBy", created_at AS "createdAt"
     FROM conversation_checkpoints
     WHERE session_id = $1 AND workspace_id = $2
     ORDER BY created_at DESC`,
    [sessionId, workspaceId],
  );
  return rows as Omit<ConversationCheckpoint, "snapshot">[];
}

export async function getCheckpoint(
  id: string,
  workspaceId: string,
): Promise<ConversationCheckpoint | null> {
  const { rows } = await getPool().query<ConversationCheckpoint>(
    `SELECT id, session_id AS "sessionId", workspace_id AS "workspaceId",
            label, message_count AS "messageCount", token_estimate AS "tokenEstimate",
            snapshot, created_by AS "createdBy", created_at AS "createdAt"
     FROM conversation_checkpoints
     WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return rows[0] ?? null;
}

export async function deleteCheckpoint(id: string, workspaceId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `DELETE FROM conversation_checkpoints WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return (rowCount ?? 0) > 0;
}
