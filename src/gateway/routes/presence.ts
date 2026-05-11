import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import {
  getPresence,
  getAgentPresence,
  updatePresence,
} from "../../agents/presence.js";

// ── Presence Router ──────────────────────────────────────────────────
// GET  /presence              — list all agent presence in workspace
// POST /presence/:agentId/heartbeat — update agent heartbeat
// GET  /presence/:agentId     — get single agent presence

const HeartbeatBody = z.object({
  status: z.enum(["active", "idle", "processing", "offline"]).optional(),
  currentTask: z.string().optional(),
});

export function createPresenceRouter(): Router {
  const router = Router();

  // GET /presence — list all agent presence in the user's workspace
  router.get("/", (req: Request, res: Response) => {
    const workspace = (req as unknown as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId ?? (req as AuthenticatedRequest).uid;

    const entries = getPresence(workspaceId);
    res.json({ presence: entries });
  });

  // POST /presence/:agentId/heartbeat — update agent heartbeat
  router.post("/:agentId/heartbeat", (req: Request, res: Response) => {
    const workspace = (req as unknown as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId ?? (req as AuthenticatedRequest).uid;
    const agentId = req.params.agentId as string;

    const parsed = HeartbeatBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.format() });
      return;
    }

    const status = parsed.data.status ?? "active";
    updatePresence(agentId, workspaceId, status, parsed.data.currentTask);
    res.json({ ok: true });
  });

  // GET /presence/:agentId — get single agent presence
  router.get("/:agentId", (req: Request, res: Response) => {
    const workspace = (req as unknown as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId ?? (req as AuthenticatedRequest).uid;
    const agentId = req.params.agentId as string;

    const entry = getAgentPresence(agentId, workspaceId);
    if (!entry) {
      res.status(404).json({ error: "Agent not found in presence store" });
      return;
    }
    res.json({ presence: entry });
  });

  return router;
}
