import { Router, type Request, type Response } from "express";
import { getPool } from "../../config/postgres.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";

// ── Trace Spans Router ───────────────────────────────────────────────
// Serves distributed trace spans in OpenTelemetry-compatible format.
//   GET /trace-spans/:traceId — all spans for a given trace

export function createTraceSpansRouter(): Router {
  const router = Router();

  // GET /trace-spans/:traceId — fetch all spans for a trace (workspace-isolated)
  router.get("/:traceId", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const { traceId } = req.params as { traceId: string };

    try {
      const pool = getPool();
      const result = await pool.query<{
        id: string;
        trace_id: string;
        parent_span_id: string | null;
        workspace_id: string;
        agent_id: string;
        span_type: string;
        name: string;
        attributes: Record<string, unknown>;
        start_time: string;
        end_time: string | null;
        status: string;
      }>(
        `SELECT id, trace_id, parent_span_id, workspace_id, agent_id, span_type, name,
                attributes, start_time, end_time, status
         FROM trace_spans
         WHERE workspace_id = $1 AND trace_id = $2
         ORDER BY start_time`,
        [workspaceId, traceId],
      );

      // Return in OpenTelemetry-compatible format
      const spans = result.rows.map((row) => ({
        spanId: row.id,
        traceId: row.trace_id,
        parentSpanId: row.parent_span_id ?? undefined,
        name: row.name,
        kind: row.span_type,
        attributes: row.attributes,
        startTimeUnixNano: new Date(row.start_time).getTime() * 1_000_000,
        endTimeUnixNano: row.end_time ? new Date(row.end_time).getTime() * 1_000_000 : undefined,
        status: { code: row.status === "ok" ? 1 : row.status === "error" ? 2 : 0 },
        agentId: row.agent_id,
      }));

      res.json({ traceId, spans });
    } catch (err) {
      console.error("[trace-spans] Get:", err);
      res.status(500).json({ error: "Failed to fetch trace spans" });
    }
  });

  return router;
}
