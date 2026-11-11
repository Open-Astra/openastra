import { Router } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import {
  createChain, getChains, getChain, updateChain, deleteChain,
  triggerEscalation, acknowledgeEscalation, resolveEscalation, getEscalations,
} from "../../agents/escalation.js";
import { requireOwned } from "../middleware/ownership.js";

const LevelSchema = z.object({
  agentId: z.string(),
  timeoutSeconds: z.number().int().positive(),
  confidenceThreshold: z.number().min(0).max(1).optional(),
});

const ChainBody = z.object({
  name: z.string().min(1).max(200),
  levels: z.array(LevelSchema).min(1).max(20),
});

const UpdateChainBody = z.object({
  name: z.string().min(1).max(200).optional(),
  levels: z.array(LevelSchema).min(1).max(20).optional(),
  active: z.boolean().optional(),
}).strict();

const AckBody = z.object({ agentId: z.string().min(1).max(128) });
const ResolveBody = z.object({ resolution: z.string().min(1).max(4000) });
const ESCALATION_STATUSES = z.enum(["active", "acknowledged", "resolved", "expired"]);

const TriggerBody = z.object({
  reason: z.string().min(1).max(4000),
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

  router.get("/escalation-chains/:id", requireOwned("escalationChain"), async (req, res) => {
    const chain = await getChain((req.params.id as string));
    if (!chain) return res.status(404).json({ error: "Chain not found" });
    res.json(chain);
  });

  router.put("/escalation-chains/:id", requireOwned("escalationChain"), async (req, res) => {
    const parsed = UpdateChainBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    await updateChain((req.params.id as string), parsed.data);
    res.json({ updated: true });
  });

  router.delete("/escalation-chains/:id", requireOwned("escalationChain"), async (req, res) => {
    await deleteChain((req.params.id as string));
    res.json({ deleted: true });
  });

  router.post("/escalation-chains/:id/trigger", requireOwned("escalationChain"), async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    const parsed = TriggerBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const escalation = await triggerEscalation((req.params.id as string), workspaceId, parsed.data.reason, parsed.data.context);
    res.status(201).json(escalation);
  });

  router.get("/escalations", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    const statusParsed = ESCALATION_STATUSES.optional().safeParse(req.query["status"]);
    if (!statusParsed.success) return res.status(400).json({ error: "Invalid status" });
    res.json({ escalations: await getEscalations(workspaceId, statusParsed.data) });
  });

  router.post("/escalations/:id/acknowledge", requireOwned("escalationEvent"), async (req, res) => {
    const body = AckBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "agentId required" });
    const { agentId } = body.data;
    await acknowledgeEscalation((req.params.id as string), agentId);
    res.json({ acknowledged: true });
  });

  router.post("/escalations/:id/resolve", requireOwned("escalationEvent"), async (req, res) => {
    const body = ResolveBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "resolution required" });
    const { resolution } = body.data;
    await resolveEscalation((req.params.id as string), resolution);
    res.json({ resolved: true });
  });

  return router;
}
