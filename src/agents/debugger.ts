// ── Agent Debugger ──────────────────────────────────────────────────
// Step-through debugging for agent loops. Create a debug session with
// breakpoints, then step through turns inspecting system prompts,
// inference requests/responses, tool calls, and memory state at each
// phase of execution.

import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("agent-debugger");

// ── Types ──────────────────────────────────────────────────────────

export type DebugPhase = "pre_inference" | "post_inference" | "pre_tool" | "post_tool" | "post_turn";
export type DebugStatus = "paused" | "stepping" | "running" | "completed";

export interface Breakpoint {
  type: "tool" | "turn" | "phase" | "error";
  name?: string;    // for type=tool: tool name to break on
  number?: number;  // for type=turn: turn number to break on
  phase?: DebugPhase; // for type=phase: phase to break on
}

export interface DebugSession {
  id: string;
  workspaceId: string;
  sessionId: string;
  agentId: string;
  status: DebugStatus;
  currentTurn: number;
  currentPhase: DebugPhase;
  breakpoints: Breakpoint[];
  autoCapture: boolean;
  maxTurns: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DebugSnapshot {
  id: string;
  debugSessionId: string;
  turn: number;
  phase: DebugPhase;
  systemPrompt: string | null;
  messages: unknown[];
  toolSchemas: unknown[] | null;
  memoryContext: Record<string, unknown> | null;
  inferenceRequest: Record<string, unknown> | null;
  inferenceResponse: Record<string, unknown> | null;
  toolCalls: unknown[] | null;
  toolResults: unknown[] | null;
  tokenUsage: Record<string, unknown> | null;
  durationMs: number | null;
  createdAt: Date;
}

// ── Session Management ─────────────────────────────────────────────

export async function createDebugSession(
  workspaceId: string,
  sessionId: string,
  agentId: string,
  createdBy: string,
  options?: {
    breakpoints?: Breakpoint[];
    autoCapture?: boolean;
    maxTurns?: number;
  },
): Promise<DebugSession> {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO debug_sessions
       (workspace_id, session_id, agent_id, created_by, breakpoints, auto_capture, max_turns)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
     RETURNING *`,
    [
      workspaceId, sessionId, agentId, createdBy,
      JSON.stringify(options?.breakpoints ?? []),
      options?.autoCapture ?? true,
      options?.maxTurns ?? 50,
    ],
  );
  logger.info(`Created debug session for agent ${agentId} session ${sessionId}`);
  return mapSessionRow(rows[0]);
}

export async function getDebugSession(id: string, workspaceId: string): Promise<DebugSession | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM debug_sessions WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return rows.length > 0 ? mapSessionRow(rows[0]) : null;
}

export async function listDebugSessions(workspaceId: string, limit = 20): Promise<DebugSession[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM debug_sessions WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [workspaceId, limit],
  );
  return rows.map(mapSessionRow);
}

export async function deleteDebugSession(id: string, workspaceId: string): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    `DELETE FROM debug_sessions WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return (result.rowCount ?? 0) > 0;
}

// ── Stepping ───────────────────────────────────────────────────────

/**
 * Advance the debug session to the next phase. Returns the new state
 * and whether a breakpoint was hit.
 */
export async function step(
  debugSessionId: string,
  workspaceId: string,
): Promise<{ session: DebugSession; breakpointHit: Breakpoint | null }> {
  const session = await getDebugSession(debugSessionId, workspaceId);
  if (!session) throw new Error("Debug session not found");
  if (session.status === "completed") throw new Error("Debug session already completed");

  const nextPhase = advancePhase(session.currentPhase);
  const nextTurn = nextPhase === "pre_inference" ? session.currentTurn + 1 : session.currentTurn;

  if (nextTurn > session.maxTurns) {
    await updateStatus(debugSessionId, "completed");
    return { session: { ...session, status: "completed" }, breakpointHit: null };
  }

  const pool = getPool();
  await pool.query(
    `UPDATE debug_sessions
     SET current_turn = $1, current_phase = $2, status = 'paused', updated_at = NOW()
     WHERE id = $3`,
    [nextTurn, nextPhase, debugSessionId],
  );

  const updated = { ...session, currentTurn: nextTurn, currentPhase: nextPhase, status: "paused" as DebugStatus };

  // Check breakpoints
  const hit = checkBreakpoints(updated);
  if (hit) {
    logger.info(`Breakpoint hit at turn ${nextTurn} phase ${nextPhase}: ${JSON.stringify(hit)}`);
  }

  return { session: updated, breakpointHit: hit };
}

/**
 * Continue execution until the next breakpoint or completion.
 */
export async function continueExecution(
  debugSessionId: string,
  workspaceId: string,
): Promise<{ session: DebugSession; breakpointHit: Breakpoint | null; stepsExecuted: number }> {
  let session = await getDebugSession(debugSessionId, workspaceId);
  if (!session) throw new Error("Debug session not found");

  await updateStatus(debugSessionId, "running");
  let steps = 0;
  let hit: Breakpoint | null = null;

  // Step until breakpoint or completion (max 500 steps to prevent infinite loop)
  while (steps < 500) {
    const result = await step(debugSessionId, workspaceId);
    session = result.session;
    steps++;

    if (result.breakpointHit) {
      hit = result.breakpointHit;
      break;
    }
    if (session.status === "completed") break;
  }

  return { session, breakpointHit: hit, stepsExecuted: steps };
}

/**
 * Update breakpoints on a debug session.
 */
export async function setBreakpoints(
  debugSessionId: string,
  workspaceId: string,
  breakpoints: Breakpoint[],
): Promise<DebugSession> {
  const pool = getPool();
  const { rows } = await pool.query(
    `UPDATE debug_sessions SET breakpoints = $1::jsonb, updated_at = NOW()
     WHERE id = $2 AND workspace_id = $3 RETURNING *`,
    [JSON.stringify(breakpoints), debugSessionId, workspaceId],
  );
  if (rows.length === 0) throw new Error("Debug session not found");
  return mapSessionRow(rows[0]);
}

// ── Snapshots ──────────────────────────────────────────────────────

/**
 * Capture a state snapshot at the current debug position.
 */
export async function captureSnapshot(
  debugSessionId: string,
  turn: number,
  phase: DebugPhase,
  state: {
    systemPrompt?: string;
    messages?: unknown[];
    toolSchemas?: unknown[];
    memoryContext?: Record<string, unknown>;
    inferenceRequest?: Record<string, unknown>;
    inferenceResponse?: Record<string, unknown>;
    toolCalls?: unknown[];
    toolResults?: unknown[];
    tokenUsage?: Record<string, unknown>;
    durationMs?: number;
  },
): Promise<DebugSnapshot> {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO debug_snapshots
       (debug_session_id, turn, phase, system_prompt, messages, tool_schemas,
        memory_context, inference_request, inference_response, tool_calls,
        tool_results, token_usage, duration_ms)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13)
     RETURNING *`,
    [
      debugSessionId, turn, phase,
      state.systemPrompt ?? null,
      JSON.stringify(state.messages ?? []),
      state.toolSchemas ? JSON.stringify(state.toolSchemas) : null,
      state.memoryContext ? JSON.stringify(state.memoryContext) : null,
      state.inferenceRequest ? JSON.stringify(state.inferenceRequest) : null,
      state.inferenceResponse ? JSON.stringify(state.inferenceResponse) : null,
      state.toolCalls ? JSON.stringify(state.toolCalls) : null,
      state.toolResults ? JSON.stringify(state.toolResults) : null,
      state.tokenUsage ? JSON.stringify(state.tokenUsage) : null,
      state.durationMs ?? null,
    ],
  );
  return mapSnapshotRow(rows[0]);
}

export async function getSnapshots(
  debugSessionId: string,
  turn?: number,
): Promise<DebugSnapshot[]> {
  const pool = getPool();
  const conditions = ["debug_session_id = $1"];
  const params: unknown[] = [debugSessionId];
  if (turn !== undefined) {
    conditions.push("turn = $2");
    params.push(turn);
  }
  const { rows } = await pool.query(
    `SELECT * FROM debug_snapshots WHERE ${conditions.join(" AND ")}
     ORDER BY turn ASC, created_at ASC`,
    params,
  );
  return rows.map(mapSnapshotRow);
}

export async function getSnapshot(id: string): Promise<DebugSnapshot | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM debug_snapshots WHERE id = $1`,
    [id],
  );
  return rows.length > 0 ? mapSnapshotRow(rows[0]) : null;
}

// ── Helpers ────────────────────────────────────────────────────────

const PHASE_ORDER: DebugPhase[] = ["pre_inference", "post_inference", "pre_tool", "post_tool", "post_turn"];

function advancePhase(current: DebugPhase): DebugPhase {
  const idx = PHASE_ORDER.indexOf(current);
  if (idx === -1 || idx === PHASE_ORDER.length - 1) return "pre_inference"; // wrap to next turn
  return PHASE_ORDER[idx + 1]!;
}

function checkBreakpoints(session: DebugSession): Breakpoint | null {
  for (const bp of session.breakpoints) {
    switch (bp.type) {
      case "turn":
        if (bp.number === session.currentTurn && session.currentPhase === "pre_inference") return bp;
        break;
      case "phase":
        if (bp.phase === session.currentPhase) return bp;
        break;
      // tool and error breakpoints are checked during actual execution, not stepping
    }
  }
  return null;
}

async function updateStatus(id: string, status: DebugStatus): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE debug_sessions SET status = $1, updated_at = NOW() WHERE id = $2`,
    [status, id],
  );
}

// ── Row Mappers ────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapSessionRow(row: any): DebugSession {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    agentId: row.agent_id,
    status: row.status,
    currentTurn: row.current_turn,
    currentPhase: row.current_phase,
    breakpoints: row.breakpoints ?? [],
    autoCapture: row.auto_capture,
    maxTurns: row.max_turns,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapSnapshotRow(row: any): DebugSnapshot {
  return {
    id: row.id,
    debugSessionId: row.debug_session_id,
    turn: row.turn,
    phase: row.phase,
    systemPrompt: row.system_prompt,
    messages: row.messages ?? [],
    toolSchemas: row.tool_schemas,
    memoryContext: row.memory_context,
    inferenceRequest: row.inference_request,
    inferenceResponse: row.inference_response,
    toolCalls: row.tool_calls,
    toolResults: row.tool_results,
    tokenUsage: row.token_usage,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  };
}
