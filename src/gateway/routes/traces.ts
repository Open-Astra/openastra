import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { getPool } from "../../config/postgres.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";

// ── Traces Router ────────────────────────────────────────────────────
// GET /traces        — paginated list of traces for the workspace
// GET /traces/:id    — full trace detail

const ListTracesQuery = z.object({
  agentId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export function createTracesRouter(): Router {
  const router = Router();

  // GET /traces — list traces for workspace (workspace-isolated)
  router.get("/", async (req: Request, res: Response) => {
    const { uid } = req as AuthenticatedRequest;
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;

    const parsed = ListTracesQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.format() });
      return;
    }

    const { agentId, limit, offset } = parsed.data;
    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    // Workspace or uid isolation
    if (workspaceId) {
      conditions.push(`workspace_id = $${paramIdx++}`);
      values.push(workspaceId);
    } else {
      conditions.push(`uid = $${paramIdx++}`);
      values.push(uid);
    }

    if (agentId) {
      conditions.push(`agent_id = $${paramIdx++}`);
      values.push(agentId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    try {
      const { rows } = await getPool().query(
        `SELECT id, session_id, agent_id, workspace_id, uid,
                started_at, finished_at, duration_ms,
                prompt_tokens, completion_tokens, total_tokens,
                final_status, error_message,
                jsonb_array_length(tool_calls) AS tool_call_count
         FROM agent_traces ${where}
         ORDER BY started_at DESC
         LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
        [...values, limit, offset],
      );
      res.json({ traces: rows, limit, offset });
    } catch (err) {
      console.error("[traces] List:", err);
      res.status(500).json({ error: "Failed to list traces" });
    }
  });

  // GET /traces/:id — full trace detail
  router.get("/:id", async (req: Request, res: Response) => {
    const { uid } = req as AuthenticatedRequest;
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    const traceId = req.params.id as string;

    try {
      const { rows } = await getPool().query(
        "SELECT * FROM agent_traces WHERE id = $1",
        [traceId],
      );

      if (rows.length === 0) {
        res.status(404).json({ error: "Trace not found" });
        return;
      }

      const trace = rows[0];
      // Enforce isolation: must match workspace or uid
      const ownsTrace = workspaceId
        ? trace.workspace_id === workspaceId
        : trace.uid === uid;

      if (!ownsTrace) {
        res.status(404).json({ error: "Trace not found" });
        return;
      }

      res.json({ trace });
    } catch (err) {
      console.error("[traces] Get:", err);
      res.status(500).json({ error: "Failed to get trace" });
    }
  });

  // GET /traces/:id/timeline — timeline-formatted response for visualization
  router.get("/:id/timeline", async (req: Request, res: Response) => {
    const { uid } = req as AuthenticatedRequest;
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    const traceId = req.params.id as string;

    try {
      const { rows } = await getPool().query(
        "SELECT * FROM agent_traces WHERE id = $1",
        [traceId],
      );

      if (rows.length === 0) {
        res.status(404).json({ error: "Trace not found" });
        return;
      }

      const trace = rows[0] as {
        id: string;
        workspace_id: string | null;
        uid: string;
        started_at: string;
        finished_at: string;
        duration_ms: number;
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        tool_calls: Array<{
          toolName: string;
          durationMs: number;
          error?: string;
          timestamp: number;
        }>;
        circuit_breaker_events: Array<{
          provider: string;
          event: string;
          timestamp: number;
        }>;
        final_status: string;
      };

      // Enforce isolation
      const ownsTrace = workspaceId
        ? trace.workspace_id === workspaceId
        : trace.uid === uid;

      if (!ownsTrace) {
        res.status(404).json({ error: "Trace not found" });
        return;
      }

      const traceStartMs = new Date(trace.started_at).getTime();
      const totalDurationMs = trace.duration_ms;

      // Build timeline spans from tool_calls and circuit_breaker_events
      interface TimelineSpan {
        name: string;
        startMs: number;
        durationMs: number;
        type: "inference" | "tool" | "memory" | "event";
        metadata?: Record<string, unknown>;
      }

      const spans: TimelineSpan[] = [];

      // Add tool call spans
      const toolCalls = Array.isArray(trace.tool_calls) ? trace.tool_calls : [];
      for (const tc of toolCalls) {
        const toolStartMs = tc.timestamp - traceStartMs;
        const spanType = tc.toolName.startsWith("memory") ? "memory" as const : "tool" as const;

        spans.push({
          name: `tool:${tc.toolName}`,
          startMs: Math.max(0, toolStartMs - tc.durationMs),
          durationMs: tc.durationMs,
          type: spanType,
          metadata: tc.error ? { error: tc.error } : undefined,
        });
      }

      // Add circuit breaker events as event spans
      const cbEvents = Array.isArray(trace.circuit_breaker_events) ? trace.circuit_breaker_events : [];
      for (const cb of cbEvents) {
        spans.push({
          name: `circuit-breaker:${cb.provider}`,
          startMs: Math.max(0, cb.timestamp - traceStartMs),
          durationMs: 0, // events are instantaneous
          type: "event",
          metadata: { event: cb.event, provider: cb.provider },
        });
      }

      // Estimate inference time as total minus tool execution time
      const totalToolMs = toolCalls.reduce((sum, tc) => sum + tc.durationMs, 0);
      const inferenceMs = Math.max(0, totalDurationMs - totalToolMs);

      // Add a synthetic inference span covering the non-tool time
      if (inferenceMs > 0) {
        spans.unshift({
          name: "inference",
          startMs: 0,
          durationMs: inferenceMs,
          type: "inference",
          metadata: {
            promptTokens: trace.prompt_tokens,
            completionTokens: trace.completion_tokens,
            totalTokens: trace.total_tokens,
          },
        });
      }

      // Sort spans by start time
      spans.sort((a, b) => a.startMs - b.startMs);

      res.json({
        traceId: trace.id,
        totalDurationMs,
        spans,
      });
    } catch (err) {
      console.error("[traces] Timeline:", err);
      res.status(500).json({ error: "Failed to build timeline" });
    }
  });

  return router;
}
