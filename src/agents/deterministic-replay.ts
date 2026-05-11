// ── Deterministic Replay ────────────────────────────────────────────
// Record every inference call + tool result during agent execution,
// then replay the exact same sequence for debugging, compliance,
// or regression testing. Drift detection compares replay outputs
// against the original recording.

import { createHash } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";
import type { InferenceRequest, InferenceResponse, InferenceClient, InferenceStreamDelta } from "../inference/types.js";

const logger = createLogger("deterministic-replay");

// ── Types ──────────────────────────────────────────────────────────

export interface Recording {
  id: string;
  workspaceId: string;
  sessionId: string;
  agentId: string;
  status: "recording" | "completed" | "failed";
  startedAt: Date;
  completedAt: Date | null;
  totalTurns: number;
  totalToolCalls: number;
  replayCount: number;
  lastReplayedAt: Date | null;
  createdBy: string;
}

export interface RecordingEvent {
  id: string;
  recordingId: string;
  sequenceNum: number;
  eventType: "inference_request" | "inference_response" | "tool_call" | "tool_result" | "memory_read" | "memory_write";
  payload: Record<string, unknown>;
  durationMs: number | null;
  checksum: string | null;
  createdAt: Date;
}

export interface ReplayRun {
  id: string;
  recordingId: string;
  workspaceId: string;
  status: "running" | "completed" | "diverged" | "failed";
  totalEvents: number;
  matchedEvents: number;
  divergedAtSeq: number | null;
  driftReport: Record<string, unknown> | null;
  startedAt: Date;
  completedAt: Date | null;
  createdBy: string;
}

// ── Recording ──────────────────────────────────────────────────────

/**
 * Start a new recording for an agent session.
 */
export async function startRecording(
  workspaceId: string,
  sessionId: string,
  agentId: string,
  createdBy: string,
): Promise<Recording> {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO agent_recordings (workspace_id, session_id, agent_id, created_by)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [workspaceId, sessionId, agentId, createdBy],
  );
  logger.info(`Started recording for session ${sessionId} agent ${agentId}`);
  return mapRecordingRow(rows[0]);
}

/**
 * Record an event within an active recording.
 */
export async function recordEvent(
  recordingId: string,
  eventType: RecordingEvent["eventType"],
  payload: Record<string, unknown>,
  durationMs?: number,
): Promise<void> {
  const pool = getPool();
  const checksum = computeChecksum(payload);

  // Get next sequence number
  const { rows: seqRows } = await pool.query(
    `SELECT COALESCE(MAX(sequence_num), 0)::int + 1 as next_seq
     FROM recording_events WHERE recording_id = $1`,
    [recordingId],
  );
  const seq = seqRows[0]?.next_seq ?? 1;

  await pool.query(
    `INSERT INTO recording_events (recording_id, sequence_num, event_type, payload, duration_ms, checksum)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
    [recordingId, seq, eventType, JSON.stringify(payload), durationMs ?? null, checksum],
  );

  // Update recording counters
  const counterField = eventType === "tool_call" ? "total_tool_calls" : "total_turns";
  if (eventType === "inference_response" || eventType === "tool_call") {
    await pool.query(
      `UPDATE agent_recordings SET ${counterField} = ${counterField} + 1 WHERE id = $1`,
      [recordingId],
    );
  }
}

/**
 * Complete a recording.
 */
export async function completeRecording(recordingId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE agent_recordings SET status = 'completed', completed_at = NOW() WHERE id = $1`,
    [recordingId],
  );
  logger.info(`Completed recording ${recordingId}`);
}

/**
 * Mark a recording as failed.
 */
export async function failRecording(recordingId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE agent_recordings SET status = 'failed', completed_at = NOW() WHERE id = $1`,
    [recordingId],
  );
}

// ── Replay ─────────────────────────────────────────────────────────

/**
 * Create an InferenceClient wrapper that records all calls.
 */
export function createRecordingClient(
  inner: InferenceClient,
  recordingId: string,
): InferenceClient {
  return {
    async chat(request: InferenceRequest): Promise<InferenceResponse> {
      await recordEvent(recordingId, "inference_request", request as unknown as Record<string, unknown>);
      const start = Date.now();
      const response = await inner.chat(request);
      await recordEvent(recordingId, "inference_response", response as unknown as Record<string, unknown>, Date.now() - start);
      return response;
    },

    async *chatStream(request: InferenceRequest): AsyncIterable<InferenceStreamDelta> {
      await recordEvent(recordingId, "inference_request", request as unknown as Record<string, unknown>);
      const start = Date.now();
      const chunks: InferenceStreamDelta[] = [];
      for await (const delta of inner.chatStream(request)) {
        chunks.push(delta);
        yield delta;
      }
      await recordEvent(recordingId, "inference_response", { chunks } as unknown as Record<string, unknown>, Date.now() - start);
    },
  };
}

/**
 * Create an InferenceClient that replays recorded responses instead
 * of making real LLM calls. Used for deterministic replay.
 */
export function createReplayClient(events: RecordingEvent[]): InferenceClient {
  let eventIdx = 0;

  function getNextResponse(): RecordingEvent | null {
    while (eventIdx < events.length) {
      const evt = events[eventIdx]!;
      eventIdx++;
      if (evt.eventType === "inference_response") return evt;
    }
    return null;
  }

  return {
    async chat(_request: InferenceRequest): Promise<InferenceResponse> {
      const evt = getNextResponse();
      if (!evt) throw new Error("Replay exhausted: no more recorded responses");
      return evt.payload as unknown as InferenceResponse;
    },

    async *chatStream(_request: InferenceRequest): AsyncIterable<InferenceStreamDelta> {
      const evt = getNextResponse();
      if (!evt) throw new Error("Replay exhausted: no more recorded responses");
      const chunks = (evt.payload as { chunks?: InferenceStreamDelta[] }).chunks ?? [];
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

/**
 * Run a replay of a recording and produce a drift report.
 */
export async function startReplay(
  recordingId: string,
  workspaceId: string,
  createdBy: string,
): Promise<ReplayRun> {
  const pool = getPool();

  // Create replay run
  const { rows } = await pool.query(
    `INSERT INTO replay_runs (recording_id, workspace_id, created_by)
     VALUES ($1, $2, $3) RETURNING *`,
    [recordingId, workspaceId, createdBy],
  );
  const run = mapReplayRow(rows[0]);

  // Update recording replay count
  await pool.query(
    `UPDATE agent_recordings SET replay_count = replay_count + 1, last_replayed_at = NOW() WHERE id = $1`,
    [recordingId],
  );

  return run;
}

/**
 * Compare a replay's events against the original recording.
 */
export async function compareReplay(
  replayRunId: string,
  replayEvents: Array<{ eventType: string; payload: Record<string, unknown> }>,
): Promise<{
  matched: number;
  diverged: number;
  divergences: Array<{ seq: number; field: string; expected: unknown; actual: unknown }>;
}> {
  const pool = getPool();

  // Get the recording ID from the replay run
  const { rows: runRows } = await pool.query(
    `SELECT recording_id FROM replay_runs WHERE id = $1`,
    [replayRunId],
  );
  if (runRows.length === 0) throw new Error("Replay run not found");

  const recordingId = runRows[0].recording_id;

  // Get original events
  const { rows: originalEvents } = await pool.query(
    `SELECT sequence_num, event_type, payload, checksum FROM recording_events
     WHERE recording_id = $1 ORDER BY sequence_num ASC`,
    [recordingId],
  );

  let matched = 0;
  let diverged = 0;
  const divergences: Array<{ seq: number; field: string; expected: unknown; actual: unknown }> = [];
  let firstDivergenceSeq: number | null = null;

  for (let i = 0; i < Math.min(originalEvents.length, replayEvents.length); i++) {
    const original = originalEvents[i]!;
    const replay = replayEvents[i]!;

    const originalChecksum = original.checksum ?? computeChecksum(original.payload);
    const replayChecksum = computeChecksum(replay.payload);

    if (originalChecksum === replayChecksum) {
      matched++;
    } else {
      diverged++;
      if (firstDivergenceSeq === null) firstDivergenceSeq = Number(original.sequence_num);
      divergences.push({
        seq: Number(original.sequence_num),
        field: original.event_type,
        expected: original.payload,
        actual: replay.payload,
      });
    }
  }

  // Update replay run
  const status = diverged > 0 ? "diverged" : "completed";
  await pool.query(
    `UPDATE replay_runs
     SET status = $1, total_events = $2, matched_events = $3,
         diverged_at_seq = $4, drift_report = $5::jsonb, completed_at = NOW()
     WHERE id = $6`,
    [status, matched + diverged, matched, firstDivergenceSeq, JSON.stringify({ divergences }), replayRunId],
  );

  return { matched, diverged, divergences };
}

// ── Queries ────────────────────────────────────────────────────────

export async function getRecording(id: string, workspaceId: string): Promise<Recording | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM agent_recordings WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return rows.length > 0 ? mapRecordingRow(rows[0]) : null;
}

export async function listRecordings(workspaceId: string, limit = 50): Promise<Recording[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM agent_recordings WHERE workspace_id = $1 ORDER BY started_at DESC LIMIT $2`,
    [workspaceId, limit],
  );
  return rows.map(mapRecordingRow);
}

export async function getRecordingEvents(recordingId: string): Promise<RecordingEvent[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM recording_events WHERE recording_id = $1 ORDER BY sequence_num ASC`,
    [recordingId],
  );
  return rows.map(mapEventRow);
}

export async function listReplayRuns(recordingId: string): Promise<ReplayRun[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM replay_runs WHERE recording_id = $1 ORDER BY started_at DESC`,
    [recordingId],
  );
  return rows.map(mapReplayRow);
}

export async function getReplayRun(id: string, workspaceId: string): Promise<ReplayRun | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM replay_runs WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return rows.length > 0 ? mapReplayRow(rows[0]) : null;
}

// ── Helpers ────────────────────────────────────────────────────────

function computeChecksum(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(payload), "utf-8").digest("hex");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapRecordingRow(row: any): Recording {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    agentId: row.agent_id,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    totalTurns: row.total_turns,
    totalToolCalls: row.total_tool_calls,
    replayCount: row.replay_count,
    lastReplayedAt: row.last_replayed_at,
    createdBy: row.created_by,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapEventRow(row: any): RecordingEvent {
  return {
    id: row.id,
    recordingId: row.recording_id,
    sequenceNum: row.sequence_num,
    eventType: row.event_type,
    payload: row.payload,
    durationMs: row.duration_ms,
    checksum: row.checksum,
    createdAt: row.created_at,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapReplayRow(row: any): ReplayRun {
  return {
    id: row.id,
    recordingId: row.recording_id,
    workspaceId: row.workspace_id,
    status: row.status,
    totalEvents: row.total_events,
    matchedEvents: row.matched_events,
    divergedAtSeq: row.diverged_at_seq,
    driftReport: row.drift_report,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdBy: row.created_by,
  };
}
