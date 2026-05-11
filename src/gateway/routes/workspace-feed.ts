import { Router } from "express";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { getEventBus } from "../../events/index.js";
import { getPool } from "../../config/postgres.js";

export function createWorkspaceFeedRouter(): Router {
  const router = Router();

  // GET /workspace/feed — SSE stream of workspace events
  router.get("/workspace/feed", (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const bus = getEventBus();

    // Heartbeat every 30 seconds
    const heartbeat = setInterval(() => {
      res.write(`data: ${JSON.stringify({ type: "ping", workspaceId })}\n\n`);
    }, 30_000);

    // Generic event handler — filter by workspaceId
    const handler = (payload: unknown) => {
      const p = payload as Record<string, unknown>;
      const pWorkspace = (p["workspaceId"] ?? p["workspace_id"]) as string | undefined;
      if (pWorkspace && pWorkspace !== workspaceId) return;
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    // Subscribe to common events
    const events = [
      "agent.started", "agent.completed", "tool.executed",
      "memory.written", "session.created", "webhook.dispatched",
      "inference.request",
    ] as const;

    for (const event of events) {
      bus.on(event as Parameters<typeof bus.on>[0], handler as Parameters<typeof bus.on>[1]);
    }

    req.on("close", () => {
      clearInterval(heartbeat);
      for (const event of events) {
        bus.off(event as Parameters<typeof bus.off>[0], handler as Parameters<typeof bus.off>[1]);
      }
    });
  });

  // GET /workspace/feed/history — past events from audit_log
  router.get("/workspace/feed/history", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    const limit = Math.min(parseInt(String(req.query["limit"] ?? "50"), 10), 500);
    const since = req.query["since"] ? new Date(String(req.query["since"])) : new Date(Date.now() - 3600 * 1000);
    const eventTypes = req.query["eventTypes"] ? String(req.query["eventTypes"]).split(",") : null;

    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT event, uid, metadata, created_at AS "createdAt"
       FROM audit_log
       WHERE workspace_id::text = $1
         AND created_at >= $2
         ${eventTypes ? "AND event = ANY($4)" : ""}
       ORDER BY created_at DESC
       LIMIT $3`,
      eventTypes
        ? [workspaceId, since, limit, eventTypes]
        : [workspaceId, since, limit],
    );
    res.json({ events: rows });
  });

  return router;
}
