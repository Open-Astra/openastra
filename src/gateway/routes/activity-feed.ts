import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import {
  getActivityFeed,
  clearActivityFeed,
  subscribeToFeed,
  type ActivityType,
} from "../../agents/activity-feed.js";

// ── Activity Feed Router ─────────────────────────────────────────────
// GET    /activity-feed          — list activity (query: limit, since, types)
// GET    /activity-feed/stream   — SSE endpoint for real-time updates
// DELETE /activity-feed          — clear feed

const VALID_TYPES = new Set<string>([
  "agent_started", "agent_completed", "tool_executed",
  "memory_written", "handoff", "message_sent", "error",
]);

const FeedQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  since: z.coerce.number().optional(),
  types: z.string().optional(), // comma-separated
});

export function createActivityFeedRouter(): Router {
  const router = Router();

  // GET /activity-feed
  router.get("/", (req: Request, res: Response) => {
    const workspace = (req as unknown as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId ?? (req as AuthenticatedRequest).uid;

    const parsed = FeedQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.format() });
      return;
    }

    const { limit, since, types: typesStr } = parsed.data;
    let types: ActivityType[] | undefined;
    if (typesStr) {
      const requested = typesStr.split(",").map((t) => t.trim());
      const valid = requested.filter((t) => VALID_TYPES.has(t)) as ActivityType[];
      if (valid.length > 0) types = valid;
    }

    const entries = getActivityFeed(workspaceId, { limit, since, types });
    res.json({ entries });
  });

  // GET /activity-feed/stream — SSE
  router.get("/stream", (req: Request, res: Response) => {
    const workspace = (req as unknown as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId ?? (req as AuthenticatedRequest).uid;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    // Send initial keepalive
    res.write(":ok\n\n");

    const unsub = subscribeToFeed(workspaceId, (entry) => {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    });

    req.on("close", () => {
      unsub();
    });
  });

  // DELETE /activity-feed
  router.delete("/", (req: Request, res: Response) => {
    const workspace = (req as unknown as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId ?? (req as AuthenticatedRequest).uid;

    clearActivityFeed(workspaceId);
    res.json({ ok: true });
  });

  return router;
}
