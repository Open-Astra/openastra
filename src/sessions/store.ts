import { getPool } from "../config/postgres.js";
import type {
  SessionDoc,
  SessionKey,
  MessageDoc,
  ResolvedSession,
  MemoryFilter,
} from "./types.js";
import type { AgentConfig } from "../agents/types.js";
import { randomUUID } from "node:crypto";
import { getEventBus } from "../events/index.js";
import { createLogger } from "../utils/logger.js";

const watchdogLog = createLogger("sessions/watchdog");

// ── Session Key → String ────────────────────────────────────────────

export function sessionKeyString(key: SessionKey): string {
  return `${key.surface}:${key.surfaceId}`;
}

// ── Resolve or Create Session ───────────────────────────────────────

export async function resolveSession(
  key: SessionKey,
  agentConfig: AgentConfig,
  workspaceId?: string,
  webhookUrl?: string,
  memoryFilter?: MemoryFilter,
): Promise<ResolvedSession> {
  const pool = getPool();

  // Group sessions are shared across workspace members — look up by
  // surface + surface_id + workspace. When no workspace is set, fall back
  // to per-user isolation to prevent cross-user session leakage.
  const isGroup = key.surface === "group";
  const isGroupWithWorkspace = isGroup && workspaceId;
  const sessionQuery = isGroupWithWorkspace
    ? `SELECT id, agent_id, created_at, last_active_at, message_count,
              token_count, status, compaction_summary, webhook_url, metadata
       FROM sessions
       WHERE surface = $1 AND surface_id = $2 AND workspace_id = $3
         AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`
    : `SELECT id, agent_id, created_at, last_active_at, message_count,
              token_count, status, compaction_summary, webhook_url, metadata
       FROM sessions
       WHERE user_id = $1 AND surface = $2 AND surface_id = $3 AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`;
  const sessionParams = isGroupWithWorkspace
    ? [key.surface, key.surfaceId, workspaceId]
    : [key.uid, key.surface, key.surfaceId];

  const { rows } = await pool.query<{
    id: string;
    agent_id: string;
    created_at: string;
    last_active_at: string;
    message_count: number;
    token_count: number;
    status: string;
    compaction_summary: string | null;
    webhook_url: string | null;
    metadata: Record<string, unknown> | null;
  }>(sessionQuery, sessionParams);

  if (rows.length > 0) {
    const row = rows[0]!;

    // Extract memoryFilter from stored metadata
    const storedFilter = row.metadata?.memoryFilter as MemoryFilter | undefined;

    const session: SessionDoc = {
      id: row.id,
      key,
      agentId: row.agent_id,
      createdAt: new Date(row.created_at).getTime(),
      lastActiveAt: new Date(row.last_active_at).getTime(),
      messageCount: row.message_count,
      tokenCount: row.token_count,
      status: row.status as SessionDoc["status"],
      compactionSummary: row.compaction_summary ?? undefined,
      webhookUrl: row.webhook_url ?? undefined,
      memoryFilter: storedFilter,
    };

    // Check if session should be reset
    if (shouldReset(session, agentConfig)) {
      await pool.query(
        "UPDATE sessions SET status = 'archived' WHERE id = $1",
        [session.id],
      );
      return createSession(key, agentConfig, workspaceId, webhookUrl, memoryFilter);
    }

    // Load messages
    const messages = await loadMessages(session.id);

    // Touch lastActiveAt
    await pool.query(
      "UPDATE sessions SET last_active_at = NOW() WHERE id = $1",
      [session.id],
    );

    return { session, messages, isNew: false, memoryFilter: storedFilter };
  }

  return createSession(key, agentConfig, workspaceId, webhookUrl, memoryFilter);
}

// ── Create New Session ──────────────────────────────────────────────

async function createSession(
  key: SessionKey,
  agentConfig: AgentConfig,
  workspaceId?: string,
  webhookUrl?: string,
  memoryFilter?: MemoryFilter,
): Promise<ResolvedSession> {
  const pool = getPool();
  const id = randomUUID();
  const now = Date.now();

  const initialMetadata = memoryFilter ? JSON.stringify({ memoryFilter }) : null;

  await pool.query(
    `INSERT INTO sessions (id, user_id, workspace_id, agent_id, surface, surface_id, status, webhook_url, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8)`,
    [id, key.uid, workspaceId ?? null, agentConfig.id, key.surface, key.surfaceId, webhookUrl ?? null, initialMetadata],
  );

  const session: SessionDoc = {
    id,
    key,
    agentId: agentConfig.id,
    createdAt: now,
    lastActiveAt: now,
    messageCount: 0,
    tokenCount: 0,
    status: "active",
    webhookUrl: webhookUrl ?? undefined,
    memoryFilter,
  };

  return { session, messages: [], isNew: true, memoryFilter };
}

// ── Should Reset? ───────────────────────────────────────────────────

function shouldReset(session: SessionDoc, config: AgentConfig): boolean {
  const now = Date.now();

  // Idle timeout
  const idleMs = config.session.idleTimeoutMinutes * 60 * 1000;
  if (now - session.lastActiveAt > idleMs) return true;

  // Daily reset
  const resetHour = config.session.dailyResetHour;
  const lastActive = new Date(session.lastActiveAt);
  const nowDate = new Date(now);

  const todayReset = new Date(nowDate);
  todayReset.setHours(resetHour, 0, 0, 0);

  if (todayReset > nowDate) {
    todayReset.setDate(todayReset.getDate() - 1);
  }

  if (lastActive < todayReset) return true;

  return false;
}

// ── Load Messages ───────────────────────────────────────────────────

async function loadMessages(
  sessionId: string,
  limit?: number,
): Promise<MessageDoc[]> {
  const pool = getPool();

  let query: string;
  let params: unknown[];

  if (limit) {
    query = `SELECT id, role, content, tool_calls, tool_call_id, token_estimate, timestamp
             FROM messages WHERE session_id = $1
             ORDER BY timestamp DESC LIMIT $2`;
    params = [sessionId, limit];
  } else {
    query = `SELECT id, role, content, tool_calls, tool_call_id, token_estimate, timestamp
             FROM messages WHERE session_id = $1
             ORDER BY timestamp ASC`;
    params = [sessionId];
  }

  const { rows } = await pool.query<{
    id: string;
    role: string;
    content: string;
    tool_calls: unknown;
    tool_call_id: string | null;
    token_estimate: number;
    timestamp: string;
  }>(query, params);

  const messages = rows.map((r) => ({
    id: r.id,
    role: r.role as MessageDoc["role"],
    content: r.content,
    toolCalls: r.tool_calls as MessageDoc["toolCalls"],
    toolCallId: r.tool_call_id ?? undefined,
    tokenEstimate: r.token_estimate,
    timestamp: parseInt(r.timestamp, 10),
  }));

  // If we used DESC limit, reverse to get chronological order
  if (limit) messages.reverse();

  return messages;
}

// ── Persist Message ─────────────────────────────────────────────────

export async function persistMessage(
  _uid: string,
  sessionId: string,
  message: Omit<MessageDoc, "id">,
  _workspaceId?: string,
): Promise<MessageDoc> {
  const pool = getPool();
  const id = randomUUID();

  await pool.query(
    `INSERT INTO messages (id, session_id, role, content, tool_calls, tool_call_id, token_estimate, timestamp)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      sessionId,
      message.role,
      message.content,
      message.toolCalls ? JSON.stringify(message.toolCalls) : null,
      message.toolCallId ?? null,
      message.tokenEstimate,
      message.timestamp,
    ],
  );

  // Update session counters
  await pool.query(
    `UPDATE sessions SET last_active_at = NOW(),
       message_count = (SELECT COUNT(*) FROM messages WHERE session_id = $1)
     WHERE id = $1`,
    [sessionId],
  );

  return { id, ...message };
}

// ── Deadlock Watchdog ───────────────────────────────────────────────

/**
 * Starts a periodic watchdog that detects sessions stuck in 'active' status
 * longer than 3× the interval and marks them as 'error'.
 * Returns the interval handle so the caller can clear it on shutdown.
 */
export function startDeadlockWatchdog(intervalMs = 120_000): NodeJS.Timeout {
  const thresholdSeconds = Math.floor((intervalMs / 1000) * 3);

  const handle = setInterval(async () => {
    try {
      const pool = getPool();
      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM sessions
         WHERE status = 'active'
           AND created_at < now() - INTERVAL '1 second' * $1`,
        [thresholdSeconds],
      );

      if (rows.length === 0) return;

      watchdogLog.warn(`Deadlock watchdog: ${rows.length} stuck session(s) found`);

      const bus = getEventBus();

      for (const row of rows) {
        try {
          await pool.query(
            `UPDATE sessions
             SET status = 'error',
                 metadata = jsonb_set(COALESCE(metadata, '{}'), '{error}', '"deadlock_watchdog_expired"')
             WHERE id = $1`,
            [row.id],
          );

          bus.emit("session.deadlock_expired", {
            sessionId: row.id,
            timestamp: Date.now(),
          });

          watchdogLog.warn(`Session ${row.id} marked as error (deadlock watchdog)`);
        } catch (innerErr) {
          watchdogLog.error(`Failed to expire session ${row.id}:`, innerErr);
        }
      }
    } catch (err) {
      watchdogLog.error("Deadlock watchdog query failed:", err);
    }
  }, intervalMs);

  return handle;
}

// ── Manual Reset ────────────────────────────────────────────────────

export async function resetSession(
  key: SessionKey,
  agentConfig: AgentConfig,
  workspaceId?: string,
  webhookUrl?: string,
): Promise<ResolvedSession> {
  const pool = getPool();

  // Archive all active sessions for this key.
  // Group sessions require a workspace — without one, fall back to per-user.
  if (key.surface === "group" && workspaceId) {
    await pool.query(
      `UPDATE sessions SET status = 'archived'
       WHERE surface = $1 AND surface_id = $2
         AND workspace_id = $3
         AND status = 'active'`,
      [key.surface, key.surfaceId, workspaceId],
    );
  } else {
    await pool.query(
      `UPDATE sessions SET status = 'archived'
       WHERE user_id = $1 AND surface = $2 AND surface_id = $3 AND status = 'active'`,
      [key.uid, key.surface, key.surfaceId],
    );
  }

  return createSession(key, agentConfig, workspaceId, webhookUrl);
}
