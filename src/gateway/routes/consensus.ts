import { Router } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import {
  initiateConsensus,
  submitVote,
  resolveConsensus,
  getConsensusRounds,
  getConsensusRound,
} from "../../agents/consensus.js";

const ProposalBody = z.object({
  topic: z.string(),
  description: z.string().optional(),
  participants: z.array(z.string()).min(1),
  requiredMajority: z.number().min(0.5).max(1).optional(),
});

const VoteBody = z.object({
  agentId: z.string(),
  vote: z.enum(["agree", "disagree", "abstain"]),
  reasoning: z.string(),
});

export function createConsensusRouter(): Router {
  const router = Router();

  router.post("/consensus/rounds", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    const parsed = ProposalBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const round = await initiateConsensus(workspaceId, parsed.data);
    res.status(201).json(round);
  });

  router.get("/consensus/rounds", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    const rounds = await getConsensusRounds(workspaceId);
    res.json({ rounds });
  });

  router.get("/consensus/rounds/:id", async (req, res) => {
    const round = await getConsensusRound(req.params.id);
    if (!round) return res.status(404).json({ error: "Round not found" });
    res.json(round);
  });

  router.post("/consensus/rounds/:id/votes", async (req, res) => {
    const parsed = VoteBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const vote = await submitVote(req.params.id, parsed.data.agentId, parsed.data.vote, parsed.data.reasoning);
    res.status(201).json(vote);
  });

  router.post("/consensus/rounds/:id/resolve", async (req, res) => {
    const round = await resolveConsensus(req.params.id);
    res.json(round);
  });

  return router;
}
