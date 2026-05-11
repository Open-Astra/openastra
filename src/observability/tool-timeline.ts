// ── Tool Execution Timeline ───────────────────────────────────────────
// Reconstruct a per-session gantt-style timeline of tool calls.

import { getPool } from "../config/postgres.js";

export interface ToolSpan {
  toolName: string;
  startedAt: number;   // epoch ms
  endedAt: number;     // epoch ms
  durationMs: number;
  success: boolean;
  error?: string;
}

export interface SessionTimeline {
  sessionId: string;
  spans: ToolSpan[];
  totalDurationMs: number;
  toolCount: number;
  failureCount: number;
  startedAt: number | null;
  endedAt: number | null;
}

export async function getSessionTimeline(
  sessionId: string,
  workspaceId: string,
): Promise<SessionTimeline> {
  const pool = getPool();

  const { rows } = await pool.query<{
    metadata: { toolName?: string; durationMs?: number; error?: string } | null;
    timestamp: string;
    event: string;
  }>(
    `SELECT metadata, timestamp, event
     FROM audit_log
     WHERE session_id = $1
       AND event = 'tool.executed'
       AND (metadata->>'workspaceId' = $2 OR workspace_id::text = $2)
     ORDER BY timestamp ASC`,
    [sessionId, workspaceId],
  );

  const spans: ToolSpan[] = rows.map((row) => {
    const ts = parseInt(String(row.timestamp), 10);
    const dur = row.metadata?.durationMs ?? 0;
    return {
      toolName: row.metadata?.toolName ?? "unknown",
      startedAt: ts - dur,
      endedAt: ts,
      durationMs: dur,
      success: !row.metadata?.error,
      error: row.metadata?.error,
    };
  });

  const startedAt = spans.length > 0 ? Math.min(...spans.map((s) => s.startedAt)) : null;
  const endedAt = spans.length > 0 ? Math.max(...spans.map((s) => s.endedAt)) : null;

  return {
    sessionId,
    spans,
    totalDurationMs: startedAt !== null && endedAt !== null ? endedAt - startedAt : 0,
    toolCount: spans.length,
    failureCount: spans.filter((s) => !s.success).length,
    startedAt,
    endedAt,
  };
}

export function formatTimelineAsText(timeline: SessionTimeline): string {
  if (timeline.spans.length === 0) return "No tool calls recorded for this session.";

  const start = timeline.startedAt!;
  const total = timeline.totalDurationMs || 1;
  const width = 60;

  const lines = [
    `Session: ${timeline.sessionId}`,
    `Tools: ${timeline.toolCount} | Failures: ${timeline.failureCount} | Duration: ${total}ms`,
    `${"─".repeat(width + 20)}`,
  ];

  for (const span of timeline.spans) {
    const offset = Math.floor(((span.startedAt - start) / total) * width);
    const barLen = Math.max(1, Math.floor((span.durationMs / total) * width));
    const bar = " ".repeat(offset) + (span.success ? "█" : "░").repeat(barLen);
    const label = `${span.toolName.padEnd(20)} ${String(span.durationMs).padStart(5)}ms ${span.success ? "✓" : "✗"}`;
    lines.push(`${bar.padEnd(width)} ${label}`);
  }

  return lines.join("\n");
}
