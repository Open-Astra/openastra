import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import {
  getWorkspaceReputations,
  getReputation,
  recordRating,
} from "../../agents/reputation.js";

// ── Reputation Router ────────────────────────────────────────────────
// GET  /reputation            — list all agent reputations in workspace
// GET  /reputation/:agentId   — get single agent reputation
// POST /reputation/:agentId/rate — submit a rating

const RateBody = z.object({
  positive: z.boolean(),
});

export function createReputationRouter(): Router {
  const router = Router();

  // GET / — list all agent reputations in workspace
  router.get("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;

    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    try {
      const reputations = await getWorkspaceReputations(workspaceId);
      res.json({ reputations });
    } catch (err) {
      console.error("[reputation] List:", err);
      res.status(500).json({ error: "Failed to list reputations" });
    }
  });

  // GET /:agentId — get single agent reputation
  router.get("/:agentId", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;

    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const agentId = req.params.agentId as string;

    try {
      const reputation = await getReputation(workspaceId, agentId);
      res.json({ reputation });
    } catch (err) {
      console.error("[reputation] Get:", err);
      res.status(500).json({ error: "Failed to get reputation" });
    }
  });

  // POST /:agentId/rate — submit a rating
  router.post("/:agentId/rate", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;

    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = RateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.format() });
      return;
    }

    const agentId = req.params.agentId as string;

    try {
      await recordRating(workspaceId, agentId, parsed.data.positive);
      res.json({ ok: true });
    } catch (err) {
      console.error("[reputation] Rate:", err);
      res.status(500).json({ error: "Failed to record rating" });
    }
  });

  return router;
}
