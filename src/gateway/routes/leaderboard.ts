import { Router } from "express";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { getPool } from "../../config/postgres.js";
import { addNoiseToArray, type DpConfig } from "../../security/dp-noise.js";

const DP_LEADERBOARD_CONFIG: DpConfig = { epsilon: 1.0, sensitivity: 1 };

export function createLeaderboardRouter(): Router {
  const router = Router();
  const pool = () => getPool();

  // GET /leaderboard — aggregate agent performance stats
  router.get("/leaderboard", async (req, res) => {
    const workspaceId = (req as WorkspaceAwareRequest).workspace.workspaceId;
    const period = (req.query["period"] as string) ?? "day";
    const limit = Math.min(parseInt(String(req.query["limit"] ?? "20"), 10), 100);

    const intervalMap: Record<string, string> = {
      day: "1 day", week: "7 days", month: "30 days",
    };
    const interval = intervalMap[period] ?? "1 day";

    const { rows } = await pool().query<{
      agent_id: string;
      total_requests: string;
      avg_latency_ms: string;
      p99_latency_ms: string;
      total_tokens: string;
    }>(
      `SELECT
         metadata->>'agentId' AS agent_id,
         COUNT(*) AS total_requests,
         AVG((metadata->>'durationMs')::int) AS avg_latency_ms,
         PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY (metadata->>'durationMs')::int) AS p99_latency_ms,
         SUM(COALESCE((metadata->>'totalTokens')::int, 0)) AS total_tokens
       FROM audit_log
       WHERE event = 'inference.request'
         AND workspace_id::text = $1
         AND created_at > NOW() - INTERVAL '${interval}'
       GROUP BY metadata->>'agentId'
       ORDER BY total_requests DESC
       LIMIT $2`,
      [workspaceId, limit],
    ).catch(() => ({ rows: [] as {
      agent_id: string;
      total_requests: string;
      avg_latency_ms: string;
      p99_latency_ms: string;
      total_tokens: string;
    }[] }));

    const leaderboard = rows.map((r) => ({
      agentId: r.agent_id,
      totalRequests: parseInt(r.total_requests, 10),
      avgLatencyMs: Math.round(parseFloat(r.avg_latency_ms ?? "0")),
      p99LatencyMs: Math.round(parseFloat(r.p99_latency_ms ?? "0")),
      totalTokens: parseInt(r.total_tokens, 10),
    }));

    // Apply differential privacy noise to aggregate statistics
    const noisedLeaderboard = addNoiseToArray(
      leaderboard,
      DP_LEADERBOARD_CONFIG,
      ["totalRequests", "avgLatencyMs", "p99LatencyMs", "totalTokens"],
    );

    res.json({ leaderboard: noisedLeaderboard, period, generatedAt: new Date().toISOString() });
  });

  // GET /leaderboard/:agentId — detailed stats for one agent
  router.get("/leaderboard/:agentId", async (req, res) => {
    const { agentId } = req.params as { agentId: string };
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;

    const { rows } = await pool().query(
      `SELECT
         DATE_TRUNC('hour', created_at) AS hour,
         COUNT(*) AS requests,
         AVG((metadata->>'durationMs')::int) AS avg_latency_ms,
         SUM(COALESCE((metadata->>'totalTokens')::int, 0)) AS tokens
       FROM audit_log
       WHERE event = 'inference.request'
         AND workspace_id::text = $1
         AND metadata->>'agentId' = $2
         AND created_at > NOW() - INTERVAL '7 days'
       GROUP BY DATE_TRUNC('hour', created_at)
       ORDER BY hour DESC
       LIMIT 168`,
      [workspaceId, agentId],
    ).catch(() => ({ rows: [] }));

    res.json({ agentId, hourlyStats: rows });
  });

  return router;
}
