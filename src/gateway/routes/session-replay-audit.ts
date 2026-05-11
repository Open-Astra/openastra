// ── Session Replay Audit Routes ───────────────────────────────────────
// Mount: app.use("/security/session-replay", jwtAuth(), workspaceResolver(), createSessionReplayAuditRouter())
//
// GET /security/session-replay/:sessionId — log replay request, return redacted transcript
// GET /security/session-replay-log        — paginated list of replay requests (owner only)

import { Router } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import {
  logReplayRequest,
  getRedactedTranscript,
  listReplayRequests,
} from "../../security/session-replay-audit.js";

// ── Validation ────────────────────────────────────────────────────────

const ReplayQuerySchema = z.object({
  reason: z.string().max(500).optional().default(""),
});

const LogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

// ── Helper ────────────────────────────────────────────────────────────

function resolveWorkspaceId(
  req: WorkspaceAwareRequest & AuthenticatedRequest,
): string {
  return req.workspace.workspaceId ?? req.uid;
}

// ── Router ────────────────────────────────────────────────────────────

export function createSessionReplayAuditRouter(): Router {
  const router = Router();

  // GET /:sessionId — record replay request and return redacted transcript
  router.get("/:sessionId", async (req, res) => {
    const r = req as unknown as WorkspaceAwareRequest & AuthenticatedRequest;
    const workspaceId = resolveWorkspaceId(r);
    const { sessionId } = req.params;

    const parsed = ReplayQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.format() });
      return;
    }

    const reason = parsed.data.reason;

    try {
      // Log the replay request first (compliance record)
      await logReplayRequest(sessionId, r.uid, reason, workspaceId);

      // Return redacted transcript
      const messages = await getRedactedTranscript(sessionId, workspaceId);
      res.json({ sessionId, messages, count: messages.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      if (message.includes("not found") || message.includes("does not belong")) {
        res.status(404).json({ error: message });
        return;
      }
      console.error("[session-replay-audit] GET transcript error:", err);
      res.status(500).json({ error: "Failed to retrieve session transcript" });
    }
  });

  // GET /log — paginated list of all replay requests (owner only)
  router.get("/log", requireRole("owner"), async (req, res) => {
    const r = req as unknown as WorkspaceAwareRequest & AuthenticatedRequest;
    const workspaceId = resolveWorkspaceId(r);

    const parsed = LogQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.format() });
      return;
    }

    const { limit, offset } = parsed.data;

    try {
      const result = await listReplayRequests(workspaceId, limit, offset);
      res.json({ ...result, limit, offset });
    } catch (err) {
      console.error("[session-replay-audit] GET log error:", err);
      res.status(500).json({ error: "Failed to list replay requests" });
    }
  });

  return router;
}
