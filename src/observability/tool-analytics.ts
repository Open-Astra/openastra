// ── Tool Usage Analytics ──────────────────────────────────────────────
// Per-tool call counts, success rate, p50/p99 duration, error histogram.

import { getPool } from "../config/postgres.js";
import { randomUUID } from "node:crypto";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("tool-analytics");

export interface ToolCallRecord {
  workspaceId: string;
  agentId: string;
  toolName: string;
  sessionId?: string;
  success: boolean;
  durationMs: number;
  errorType?: string;
}

export interface ToolStats {
  toolName: string;
  totalCalls: number;
  successCount: number;
  errorCount: number;
  successRate: number;
  avgDurationMs: number;
  p50DurationMs: number;
  p99DurationMs: number;
  topErrors: Array<{ errorType: string; count: number }>;
}

export async function recordToolCall(record: ToolCallRecord): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO tool_usage_stats
         (id, workspace_id, agent_id, tool_name, session_id, success, duration_ms, error_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        randomUUID(), record.workspaceId, record.agentId, record.toolName,
        record.sessionId ?? null, record.success, record.durationMs,
        record.errorType ?? null,
      ],
    );
  } catch (err) {
    logger.warn(`Failed to record tool call: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function getToolStats(
  workspaceId: string,
  toolName?: string,
  windowHours = 24,
): Promise<ToolStats[]> {
  const whereClause = toolName
    ? "WHERE workspace_id = $1 AND tool_name = $2 AND created_at > NOW() - INTERVAL '1 hour' * $3"
    : "WHERE workspace_id = $1 AND created_at > NOW() - INTERVAL '1 hour' * $2";
  const params = toolName
    ? [workspaceId, toolName, windowHours]
    : [workspaceId, windowHours];

  const { rows } = await getPool().query(
    `SELECT
       tool_name AS "toolName",
       COUNT(*) AS "totalCalls",
       SUM(CASE WHEN success THEN 1 ELSE 0 END) AS "successCount",
       SUM(CASE WHEN NOT success THEN 1 ELSE 0 END) AS "errorCount",
       AVG(duration_ms) AS "avgDurationMs",
       PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) AS "p50DurationMs",
       PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration_ms) AS "p99DurationMs"
     FROM tool_usage_stats
     ${whereClause}
     GROUP BY tool_name
     ORDER BY "totalCalls" DESC`,
    params,
  );

  const stats = rows as Array<Record<string, unknown>>;

  // Fetch top errors per tool
  const result: ToolStats[] = [];
  for (const row of stats) {
    const toolName2 = row["toolName"] as string;
    const total = parseInt(String(row["totalCalls"]), 10);
    const success = parseInt(String(row["successCount"]), 10);
    const errorCount = parseInt(String(row["errorCount"]), 10);

    const { rows: errRows } = await getPool().query(
      `SELECT error_type AS "errorType", COUNT(*) AS count
       FROM tool_usage_stats
       WHERE workspace_id = $1 AND tool_name = $2 AND NOT success
         AND created_at > NOW() - INTERVAL '1 hour' * $3
       GROUP BY error_type ORDER BY count DESC LIMIT 5`,
      [workspaceId, toolName2, windowHours],
    );

    result.push({
      toolName: toolName2,
      totalCalls: total,
      successCount: success,
      errorCount,
      successRate: total > 0 ? success / total : 0,
      avgDurationMs: Math.round(parseFloat(String(row["avgDurationMs"] ?? 0))),
      p50DurationMs: Math.round(parseFloat(String(row["p50DurationMs"] ?? 0))),
      p99DurationMs: Math.round(parseFloat(String(row["p99DurationMs"] ?? 0))),
      topErrors: errRows as Array<{ errorType: string; count: number }>,
    });
  }
  return result;
}

export async function getToolHistogram(
  workspaceId: string,
  toolName: string,
  windowHours = 24,
): Promise<Array<{ hour: string; calls: number; errors: number; avgMs: number }>> {
  const { rows } = await getPool().query(
    `SELECT
       DATE_TRUNC('hour', created_at) AS hour,
       COUNT(*) AS calls,
       SUM(CASE WHEN NOT success THEN 1 ELSE 0 END) AS errors,
       AVG(duration_ms) AS "avgMs"
     FROM tool_usage_stats
     WHERE workspace_id = $1 AND tool_name = $2
       AND created_at > NOW() - INTERVAL '1 hour' * $3
     GROUP BY DATE_TRUNC('hour', created_at)
     ORDER BY hour DESC`,
    [workspaceId, toolName, windowHours],
  );
  return rows as Array<{ hour: string; calls: number; errors: number; avgMs: number }>;
}
