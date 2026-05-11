import type { RequestHandler, Request, Response } from "express";
import { getEventBus } from "../events/index.js";
import type { WorkspaceAwareRequest } from "../gateway/middleware/workspace.js";
import type { AuthenticatedRequest } from "../gateway/middleware/auth.js";
import type { EventName, AnyEventPayload } from "../events/types.js";
import { createLogger } from "../utils/logger.js";

// ── Dashboard SSE Handler ────────────────────────────────────────────
// Streams real-time agent activity events to connected dashboard clients.
// Subscribes to the event bus and forwards relevant events filtered to
// the requesting user's workspace.

const log = createLogger("dashboard-sse");

const DASHBOARD_EVENTS: EventName[] = [
  "agent.started",
  "agent.completed",
  "tool.executed",
  "agent.stream.delta",
];

const PING_INTERVAL_MS = 30_000;

export function createDashboardSseHandler(): RequestHandler {
  return (req: Request, res: Response): void => {
    const workspaceId = (req as WorkspaceAwareRequest).workspace?.workspaceId ?? null;
    const uid = (req as AuthenticatedRequest).uid;

    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const bus = getEventBus();
    const unsubscribers: Array<() => void> = [];

    function sendEvent(type: string, data: unknown): void {
      const payload = JSON.stringify({
        type,
        timestamp: Date.now(),
        workspaceId,
        data,
      });
      res.write(`data: ${payload}\n\n`);
    }

    // Subscribe to each dashboard event
    for (const eventName of DASHBOARD_EVENTS) {
      const unsub = bus.on(eventName as EventName, (payload: AnyEventPayload) => {
        // Filter to requesting user's workspace
        const p = payload as Record<string, unknown>;
        const eventWorkspaceId = p["workspaceId"] as string | undefined;
        const eventUid = p["uid"] as string | undefined;

        // If workspace context: filter by workspaceId when present in event
        // For events without workspaceId, fall back to uid match
        const allowed = workspaceId
          ? (eventWorkspaceId === workspaceId || (!eventWorkspaceId && eventUid === uid))
          : (eventUid === uid);

        if (!allowed) return;

        sendEvent(eventName, payload);
      });
      unsubscribers.push(unsub as () => void);
    }

    // Keep-alive ping every 30 seconds
    const pingTimer = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        cleanup();
      }
    }, PING_INTERVAL_MS);

    function cleanup(): void {
      clearInterval(pingTimer);
      for (const unsub of unsubscribers) {
        try { unsub(); } catch { /* ignore */ }
      }
      log.dim(`Dashboard SSE client disconnected (uid=${uid})`);
    }

    req.on("close", cleanup);
    req.on("error", cleanup);

    log.dim(`Dashboard SSE client connected (uid=${uid}, workspace=${workspaceId ?? "personal"})`);
  };
}
