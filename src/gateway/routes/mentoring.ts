import { Router } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import {
  createMentorshipPair, getMentorshipPairs, getMentorshipPair,
  endMentorship, recordMentoringSession, getMentoringSessions,
} from "../../agents/mentoring.js";

const PairBody = z.object({
  mentorId: z.string(),
  menteeId: z.string(),
  focus: z.array(z.string()).default([]),
});

const SessionBody = z.object({
  insights: z.object({
    promptPatterns: z.array(z.string()).optional(),
    toolStrategies: z.array(z.string()).optional(),
    heuristics: z.array(z.string()).optional(),
  }),
});

export function createMentoringRouter(): Router {
  const router = Router();

  router.post("/mentoring/pairs", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    const parsed = PairBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const pair = await createMentorshipPair(workspaceId, parsed.data.mentorId, parsed.data.menteeId, parsed.data.focus);
    res.status(201).json(pair);
  });

  router.get("/mentoring/pairs", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    const pairs = await getMentorshipPairs(workspaceId);
    res.json({ pairs });
  });

  router.get("/mentoring/pairs/:id", async (req, res) => {
    const pair = await getMentorshipPair(req.params.id);
    if (!pair) return res.status(404).json({ error: "Pair not found" });
    res.json(pair);
  });

  router.delete("/mentoring/pairs/:id", async (req, res) => {
    await endMentorship(req.params.id);
    res.json({ ended: true });
  });

  router.post("/mentoring/pairs/:id/sessions", async (req, res) => {
    const parsed = SessionBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const session = await recordMentoringSession(req.params.id, parsed.data.insights);
    res.status(201).json(session);
  });

  router.get("/mentoring/pairs/:id/sessions", async (req, res) => {
    const sessions = await getMentoringSessions(req.params.id);
    res.json({ sessions });
  });

  return router;
}
