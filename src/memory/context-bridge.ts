import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

// ── Cross-Session Context Bridge ────────────────────────────────────
// Bridges context across sessions so agents don't start from zero.
// When a new session starts, the bridge loads:
//   1. Recent session summaries (last 3 sessions)
//   2. Active reminders and pending tasks
//   3. Relevant memory chunks (semantic search on last session's topic)
//   4. User profile preferences
//
// This creates a "warm start" that maintains conversation continuity.

const log = createLogger("context-bridge");

const ENSURE_TABLE = `
CREATE TABLE IF NOT EXISTS session_summaries (
  id SERIAL PRIMARY KEY,
  uid TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE,
  summary TEXT NOT NULL,
  topics TEXT[] DEFAULT '{}',
  key_decisions TEXT[] DEFAULT '{}',
  pending_actions TEXT[] DEFAULT '{}',
  message_count INTEGER DEFAULT 0,
  duration_minutes INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_session_summaries_uid ON session_summaries(uid, created_at DESC)`;

let tableReady = false;
async function ensureTable(): Promise<void> {
  if (tableReady) return;
  await getPool().query(ENSURE_TABLE);
  tableReady = true;
}

export interface SessionSummary {
  sessionId: string;
  summary: string;
  topics: string[];
  keyDecisions: string[];
  pendingActions: string[];
  messageCount: number;
  durationMinutes: number;
  createdAt: Date;
}

/**
 * Save a session summary when a session ends.
 */
export async function saveSessionSummary(
  uid: string,
  agentId: string,
  sessionId: string,
  data: {
    summary: string;
    topics: string[];
    keyDecisions: string[];
    pendingActions: string[];
    messageCount: number;
    durationMinutes: number;
  },
): Promise<void> {
  await ensureTable();

  await getPool().query(
    `INSERT INTO session_summaries (uid, agent_id, session_id, summary, topics, key_decisions, pending_actions, message_count, duration_minutes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (session_id) DO UPDATE SET
       summary = $4, topics = $5, key_decisions = $6, pending_actions = $7,
       message_count = $8, duration_minutes = $9`,
    [uid, agentId, sessionId, data.summary, data.topics, data.keyDecisions,
     data.pendingActions, data.messageCount, data.durationMinutes],
  );
}

/**
 * Load recent session summaries for context bridging.
 */
export async function loadRecentSessions(
  uid: string,
  agentId?: string,
  limit: number = 3,
): Promise<SessionSummary[]> {
  await ensureTable();

  const agentFilter = agentId ? "AND agent_id = $3" : "";
  const params: unknown[] = [uid, limit];
  if (agentId) params.push(agentId);

  const result = await getPool().query<{
    session_id: string;
    summary: string;
    topics: string[];
    key_decisions: string[];
    pending_actions: string[];
    message_count: number;
    duration_minutes: number;
    created_at: Date;
  }>(
    `SELECT session_id, summary, topics, key_decisions, pending_actions,
            message_count, duration_minutes, created_at
     FROM session_summaries
     WHERE uid = $1 ${agentFilter}
     ORDER BY created_at DESC
     LIMIT $2`,
    params,
  );

  return result.rows.map((r) => ({
    sessionId: r.session_id,
    summary: r.summary,
    topics: r.topics ?? [],
    keyDecisions: r.key_decisions ?? [],
    pendingActions: r.pending_actions ?? [],
    messageCount: r.message_count,
    durationMinutes: r.duration_minutes,
    createdAt: r.created_at,
  }));
}

/**
 * Get all pending actions across recent sessions (unresolved tasks).
 */
export async function getPendingActions(
  uid: string,
  limit: number = 10,
): Promise<string[]> {
  await ensureTable();

  const result = await getPool().query<{ pending_actions: string[] }>(
    `SELECT pending_actions FROM session_summaries
     WHERE uid = $1 AND array_length(pending_actions, 1) > 0
     ORDER BY created_at DESC LIMIT 5`,
    [uid],
  );

  const actions = result.rows.flatMap((r) => r.pending_actions ?? []);
  return actions.slice(0, limit);
}

/**
 * Build warm-start context for a new session.
 * This is the main entry point: call at session start to get
 * a context block that can be injected into the system prompt.
 */
export async function buildSessionContext(
  uid: string,
  agentId: string,
): Promise<string> {
  const sections: string[] = [];

  try {
    // 1. Recent session summaries
    const recentSessions = await loadRecentSessions(uid, agentId, 3);
    if (recentSessions.length > 0) {
      const sessionText = recentSessions
        .map((s) => {
          const date = s.createdAt.toISOString().slice(0, 10);
          const decisions = s.keyDecisions.length > 0 ? `\n  Decisions: ${s.keyDecisions.join("; ")}` : "";
          return `- [${date}] ${s.summary}${decisions}`;
        })
        .join("\n");
      sections.push(`## Recent Sessions\n${sessionText}`);
    }

    // 2. Pending actions
    const pending = await getPendingActions(uid, 5);
    if (pending.length > 0) {
      sections.push(`## Pending Actions\n${pending.map((a) => `- ${a}`).join("\n")}`);
    }

    // 3. Recurring topics (from last session for semantic continuity)
    if (recentSessions.length > 0 && recentSessions[0]!.topics.length > 0) {
      sections.push(`## Active Topics\n${recentSessions[0]!.topics.join(", ")}`);
    }
  } catch (err) {
    log.dim("Context bridge partial failure:", err instanceof Error ? err.message : "");
  }

  if (sections.length === 0) return "";

  return `[Session Context — Bridged from previous interactions]\n${sections.join("\n\n")}`;
}
