// ── Session Replay Audit ──────────────────────────────────────────────
// Records when a session is replayed/reviewed for compliance purposes.
// Provides a read-only session transcript view with PII redaction.

import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";
import { redactPII } from "../secrets/scanner.js";

const log = createLogger("session-replay-audit");

// ── Types ─────────────────────────────────────────────────────────────

export interface RedactedMessage {
  role: string;
  content: string;
  timestamp: string | null;
}

export interface ReplayRequest {
  id: string;
  workspaceId: string;
  sessionId: string;
  requestedBy: string;
  reason: string | null;
  createdAt: string;
}

// ── DB Rows ───────────────────────────────────────────────────────────

interface MessageRow {
  role: string;
  content: string;
  created_at: string | null;
}

interface ReplayRow {
  id: string;
  workspace_id: string;
  session_id: string;
  requested_by: string;
  reason: string | null;
  created_at: string;
}

interface SessionOwnerRow {
  workspace_id: string | null;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Log that a session is being replayed for compliance/auditing.
 * Always records the request regardless of whether the session exists.
 */
export async function logReplayRequest(
  sessionId: string,
  requestedBy: string,
  reason: string,
  workspaceId: string,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO session_replay_requests (workspace_id, session_id, requested_by, reason)
     VALUES ($1, $2, $3, $4)`,
    [workspaceId, sessionId, requestedBy, reason || null],
  );
  log.info(
    `Session replay logged: session=${sessionId} by=${requestedBy} workspace=${workspaceId}`,
  );
}

/**
 * Return a redacted transcript for a session scoped to a workspace.
 * Verifies workspace ownership before returning data.
 */
export async function getRedactedTranscript(
  sessionId: string,
  workspaceId: string,
): Promise<RedactedMessage[]> {
  const pool = getPool();

  // Verify session belongs to this workspace
  const sessionCheck = await pool.query<SessionOwnerRow>(
    `SELECT workspace_id FROM sessions WHERE id = $1`,
    [sessionId],
  );

  if (sessionCheck.rows.length === 0) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const sessionWorkspace = sessionCheck.rows[0]!.workspace_id;
  if (sessionWorkspace !== workspaceId && sessionWorkspace !== null) {
    throw new Error(`Session does not belong to workspace: ${workspaceId}`);
  }

  const { rows } = await pool.query<MessageRow>(
    `SELECT role, content, created_at
     FROM session_messages
     WHERE session_id = $1
     ORDER BY created_at ASC`,
    [sessionId],
  );

  return rows.map((row) => {
    const contentStr =
      typeof row.content === "string"
        ? row.content
        : JSON.stringify(row.content);
    const { redacted } = redactPII(contentStr);
    return {
      role: row.role,
      content: redacted,
      timestamp: row.created_at ?? null,
    };
  });
}

/**
 * List all replay requests for a workspace, paginated.
 */
export async function listReplayRequests(
  workspaceId: string,
  limit: number,
  offset: number,
): Promise<{ requests: ReplayRequest[]; total: number }> {
  const pool = getPool();

  const [dataResult, countResult] = await Promise.all([
    pool.query<ReplayRow>(
      `SELECT id, workspace_id, session_id, requested_by, reason, created_at
       FROM session_replay_requests
       WHERE workspace_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [workspaceId, limit, offset],
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM session_replay_requests WHERE workspace_id = $1`,
      [workspaceId],
    ),
  ]);

  const requests: ReplayRequest[] = dataResult.rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    sessionId: r.session_id,
    requestedBy: r.requested_by,
    reason: r.reason,
    createdAt: r.created_at,
  }));

  return {
    requests,
    total: parseInt(countResult.rows[0]?.count ?? "0", 10),
  };
}
