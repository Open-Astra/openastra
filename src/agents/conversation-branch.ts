// ── Conversation Branching ───────────────────────────────────────────
// Fork a session at any message index and explore alternate paths.

import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("conversation-branch");

export interface BranchInfo {
  id: string;
  parentSessionId: string;
  branchSessionId: string;
  fromMessageIndex: number;
  label: string | null;
  workspaceId: string;
  createdBy: string | null;
  createdAt: Date;
}

/**
 * Fork a session at `fromMessageIndex`. Copies all messages up to that index
 * into a new session, then records the branch relationship.
 */
export async function branchSession(
  parentSessionId: string,
  fromMessageIndex: number,
  workspaceId: string,
  options: { label?: string; createdBy?: string } = {},
): Promise<{ branchId: string; branchSessionId: string }> {
  const pool = getPool();
  const branchSessionId = randomUUID();
  const branchId = randomUUID();

  // Fetch messages up to the branch point
  const { rows: messages } = await pool.query<{
    role: string;
    content: string;
    metadata: unknown;
  }>(
    `SELECT role, content, metadata FROM messages
     WHERE session_id = $1
     ORDER BY created_at ASC
     LIMIT $2`,
    [parentSessionId, fromMessageIndex + 1],
  );

  // Fetch parent session metadata
  const { rows: parentSessions } = await pool.query<{
    agent_id: string;
    surface: string;
    surface_id: string;
    uid: string;
  }>(
    `SELECT agent_id, surface, surface_id, uid FROM sessions WHERE id = $1 AND workspace_id = $2`,
    [parentSessionId, workspaceId],
  );

  if (parentSessions.length === 0) {
    throw new Error(`Session ${parentSessionId} not found in workspace ${workspaceId}`);
  }

  const parent = parentSessions[0]!;

  await pool.query("BEGIN");
  try {
    // Create the branch session
    await pool.query(
      `INSERT INTO sessions (id, uid, agent_id, surface, surface_id, workspace_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        branchSessionId,
        parent.uid,
        parent.agent_id,
        parent.surface,
        `branch:${parent.surface_id}:${branchId}`,
        workspaceId,
        JSON.stringify({ branchedFrom: parentSessionId, branchPoint: fromMessageIndex }),
      ],
    );

    // Copy messages into branch session
    for (const msg of messages) {
      await pool.query(
        `INSERT INTO messages (id, session_id, role, content, metadata)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [randomUUID(), branchSessionId, msg.role, msg.content, JSON.stringify(msg.metadata ?? {})],
      );
    }

    // Record the branch relationship
    await pool.query(
      `INSERT INTO session_branches (id, parent_session_id, branch_session_id, from_message_index, label, workspace_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [branchId, parentSessionId, branchSessionId, fromMessageIndex, options.label ?? null, workspaceId, options.createdBy ?? null],
    );

    await pool.query("COMMIT");
  } catch (err) {
    await pool.query("ROLLBACK");
    throw err;
  }

  logger.info(`Branched session ${parentSessionId} at message ${fromMessageIndex} → ${branchSessionId}`);
  return { branchId, branchSessionId };
}

export async function listBranches(parentSessionId: string, workspaceId: string): Promise<BranchInfo[]> {
  const pool = getPool();
  const { rows } = await pool.query<BranchInfo>(
    `SELECT id, parent_session_id AS "parentSessionId", branch_session_id AS "branchSessionId",
            from_message_index AS "fromMessageIndex", label, workspace_id AS "workspaceId",
            created_by AS "createdBy", created_at AS "createdAt"
     FROM session_branches
     WHERE parent_session_id = $1 AND workspace_id = $2
     ORDER BY created_at DESC`,
    [parentSessionId, workspaceId],
  );
  return rows;
}

export async function getBranch(branchId: string, workspaceId: string): Promise<BranchInfo | null> {
  const pool = getPool();
  const { rows } = await pool.query<BranchInfo>(
    `SELECT id, parent_session_id AS "parentSessionId", branch_session_id AS "branchSessionId",
            from_message_index AS "fromMessageIndex", label, workspace_id AS "workspaceId",
            created_by AS "createdBy", created_at AS "createdAt"
     FROM session_branches
     WHERE id = $1 AND workspace_id = $2`,
    [branchId, workspaceId],
  );
  return rows[0] ?? null;
}
