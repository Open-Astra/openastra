// ── Agent Replay / Time-Travel ────────────────────────────────────────
// Reconstruct a full session step-by-step for inspection and debugging.

import { getPool } from "../config/postgres.js";

export interface ReplayStep {
  stepIndex: number;
  messageRole: string;
  messageContent: string;
  toolCalls?: unknown[];
  tokenEstimate: number;
  timestamp: string;
}

export interface SessionReplay {
  sessionId: string;
  agentId: string | null;
  steps: ReplayStep[];
  totalSteps: number;
  durationMs: number;
}

const CHARS_PER_TOKEN = 4;

function estimateTokens(content: string): number {
  return Math.ceil(content.length / CHARS_PER_TOKEN);
}

export async function buildReplay(
  sessionId: string,
  workspaceId: string,
): Promise<SessionReplay> {
  const pool = getPool();

  // Verify workspace ownership
  const { rows: sessions } = await pool.query<{ agent_id: string | null }>(
    `SELECT agent_id FROM sessions WHERE id = $1 AND workspace_id = $2`,
    [sessionId, workspaceId],
  );
  if (sessions.length === 0) throw new Error(`Session ${sessionId} not found in workspace ${workspaceId}`);

  const { rows: messages } = await pool.query<{
    role: string;
    content: string;
    metadata: { tool_calls?: unknown[] } | null;
    created_at: string;
  }>(
    `SELECT role, content, metadata, created_at
     FROM messages
     WHERE session_id = $1
     ORDER BY created_at ASC`,
    [sessionId],
  );

  const steps: ReplayStep[] = messages.map((msg, i) => ({
    stepIndex: i,
    messageRole: msg.role,
    messageContent: msg.content ?? "",
    toolCalls: msg.metadata?.tool_calls,
    tokenEstimate: estimateTokens(msg.content ?? ""),
    timestamp: msg.created_at,
  }));

  const firstTs = steps[0]?.timestamp ? new Date(steps[0].timestamp).getTime() : 0;
  const lastTs = steps[steps.length - 1]?.timestamp ? new Date(steps[steps.length - 1]!.timestamp).getTime() : 0;

  return {
    sessionId,
    agentId: sessions[0]!.agent_id,
    steps,
    totalSteps: steps.length,
    durationMs: lastTs - firstTs,
  };
}

export async function getReplayStep(
  sessionId: string,
  stepIndex: number,
  workspaceId: string,
): Promise<ReplayStep | null> {
  const replay = await buildReplay(sessionId, workspaceId);
  return replay.steps[stepIndex] ?? null;
}
