import { Router } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import {
  createPairSession, addTurn, endSession, getPairSessions, getPairSession,
} from "../../agents/pair-programming.js";

const CreateBody = z.object({
  generatorId: z.string(),
  reviewerId: z.string(),
  task: z.string(),
});

const TurnBody = z.object({
  agentId: z.string(),
  role: z.enum(["generate", "review", "interrupt"]),
  content: z.string(),
});

const EndBody = z.object({
  outcome: z.enum(["completed", "abandoned"]),
  qualityScore: z.number().min(0).max(1).optional(),
});

export function createPairSessionsRouter(): Router {
  const router = Router();

  router.post("/pair-sessions", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const session = await createPairSession(workspaceId, parsed.data.generatorId, parsed.data.reviewerId, parsed.data.task);
    res.status(201).json(session);
  });

  router.get("/pair-sessions", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    res.json({ sessions: await getPairSessions(workspaceId) });
  });

  router.get("/pair-sessions/:id", async (req, res) => {
    const session = await getPairSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    res.json(session);
  });

  router.post("/pair-sessions/:id/turns", async (req, res) => {
    const parsed = TurnBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const turn = await addTurn(req.params.id, parsed.data.agentId, parsed.data.role, parsed.data.content);
    res.status(201).json(turn);
  });

  router.post("/pair-sessions/:id/end", async (req, res) => {
    const parsed = EndBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    await endSession(req.params.id, parsed.data.outcome, parsed.data.qualityScore);
    res.json({ ended: true });
  });

  return router;
}
