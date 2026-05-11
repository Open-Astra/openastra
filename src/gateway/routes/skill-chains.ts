import { Router } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import {
  createSkillChain,
  listSkillChains,
  getSkillChain,
  deleteSkillChain,
  resolveSkillChainTools,
  resolveSkillChainContext,
} from "../../agents/skill-chain.js";

const CreateBody = z.object({
  name: z.string().min(1).max(100),
  skills: z.array(z.string()).min(1),
  description: z.string().max(500).optional(),
});

export function createSkillChainsRouter(): Router {
  const router = Router();

  router.get("/skill-chains", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    const chains = await listSkillChains(workspaceId);
    res.json({ chains });
  });

  router.post("/skill-chains", async (req, res) => {
    const body = CreateBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: body.error.issues }); return; }
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    const chain = await createSkillChain(
      workspaceId,
      body.data.name,
      body.data.skills,
      body.data.description,
    );
    res.status(201).json(chain);
  });

  router.get("/skill-chains/:id", async (req, res) => {
    const { id } = req.params as { id: string };
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    const chain = await getSkillChain(id, workspaceId);
    if (!chain) { res.status(404).json({ error: "Skill chain not found" }); return; }
    const tools = resolveSkillChainTools(chain.skills);
    res.json({ ...chain, resolvedTools: tools });
  });

  router.get("/skill-chains/:id/context", async (req, res) => {
    const { id } = req.params as { id: string };
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    const chain = await getSkillChain(id, workspaceId);
    if (!chain) { res.status(404).json({ error: "Skill chain not found" }); return; }
    const context = await resolveSkillChainContext(chain.skills);
    res.json({ context });
  });

  router.delete("/skill-chains/:id", async (req, res) => {
    const { id } = req.params as { id: string };
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    const deleted = await deleteSkillChain(id, workspaceId);
    if (!deleted) { res.status(404).json({ error: "Skill chain not found" }); return; }
    res.json({ deleted: true });
  });

  return router;
}
