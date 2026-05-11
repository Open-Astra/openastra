import { Router } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import {
  createChain, getChains, getChain, updateChain, deleteChain,
  triggerEscalation, acknowledgeEscalation, resolveEscalation, getEscalations,
} from "../../agents/escalation.js";

const LevelSchema = z.object({
  agentId: z.string(),
  timeoutSeconds: z.number().int().positive(),
  confidenceThreshold: z.number().min(0).max(1).optional(),
});

const ChainBody = z.object({
  name: z.string(),
  levels: z.array(LevelSchema).min(1),
});

const TriggerBody = z.object({
  reason: z.string(),
  context: z.unknown().optional(),
});

export function createEscalationChainsRouter(): Router {
  const router = Router();

  router.post("/escalation-chains", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    const parsed = ChainBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const chain = await createChain(workspaceId, parsed.data);
    res.status(201).json(chain);
  });

  router.get("/escalation-chains", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    res.json({ chains: await getChains(workspaceId) });
  });

  router.get("/escalation-chains/:id", async (req, res) => {
    const chain = await getChain(req.params.id);
    if (!chain) return res.status(404).json({ error: "Chain not found" });
    res.json(chain);
  });

  router.put("/escalation-chains/:id", async (req, res) => {
    await updateChain(req.params.id, req.body);
    res.json({ updated: true });
  });

  router.delete("/escalation-chains/:id", async (req, res) => {
    await deleteChain(req.params.id);
    res.json({ deleted: true });
  });

  router.post("/escalation-chains/:id/trigger", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    const parsed = TriggerBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const escalation = await triggerEscalation(req.params.id, workspaceId, parsed.data.reason, parsed.data.context);
    res.status(201).json(escalation);
  });

  router.get("/escalations", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    const status = req.query["status"] ? String(req.query["status"]) : undefined;
    res.json({ escalations: await getEscalations(workspaceId, status) });
  });

  router.post("/escalations/:id/acknowledge", async (req, res) => {
    const { agentId } = req.body;
    if (!agentId) return res.status(400).json({ error: "agentId required" });
    await acknowledgeEscalation(req.params.id, agentId);
    res.json({ acknowledged: true });
  });

  router.post("/escalations/:id/resolve", async (req, res) => {
    const { resolution } = req.body;
    if (!resolution) return res.status(400).json({ error: "resolution required" });
    await resolveEscalation(req.params.id, resolution);
    res.json({ resolved: true });
  });

  return router;
}
