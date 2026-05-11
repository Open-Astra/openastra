import { Router } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import {
  createLiaison,
  getLiaisons,
  getLiaison,
  deactivateLiaison,
  recordHandoff,
  getLiaisonHandoffs,
} from "../../agents/liaison.js";

const CreateBody = z.object({
  agentId: z.string().min(1),
  teamA: z.string().min(1),
  teamB: z.string().min(1),
});

const HandoffBody = z.object({
  fromTeam: z.string().min(1),
  toTeam: z.string().min(1),
  summary: z.string().min(1),
});

export function createLiaisonsRouter(): Router {
  const router = Router();

  router.post("/liaisons", async (req, res) => {
    const body = CreateBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: body.error.issues }); return; }
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    try {
      const liaison = await createLiaison(workspaceId, body.data.agentId, body.data.teamA, body.data.teamB);
      res.status(201).json(liaison);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.get("/liaisons", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    try {
      const liaisons = await getLiaisons(workspaceId);
      res.json({ liaisons });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.get("/liaisons/:id", async (req, res) => {
    const { id } = req.params as { id: string };
    try {
      const liaison = await getLiaison(id);
      if (!liaison) { res.status(404).json({ error: "Liaison not found" }); return; }
      res.json(liaison);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.delete("/liaisons/:id", async (req, res) => {
    const { id } = req.params as { id: string };
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    try {
      const ok = await deactivateLiaison(id, workspaceId);
      if (!ok) { res.status(404).json({ error: "Liaison not found" }); return; }
      res.json({ deactivated: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post("/liaisons/:id/handoffs", async (req, res) => {
    const body = HandoffBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: body.error.issues }); return; }
    const { id } = req.params as { id: string };
    try {
      const handoff = await recordHandoff(id, body.data.fromTeam, body.data.toTeam, body.data.summary);
      res.status(201).json(handoff);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.get("/liaisons/:id/handoffs", async (req, res) => {
    const { id } = req.params as { id: string };
    try {
      const handoffs = await getLiaisonHandoffs(id);
      res.json({ handoffs });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
