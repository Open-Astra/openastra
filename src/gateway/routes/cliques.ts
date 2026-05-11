import { Router } from "express";
import { z } from "zod";
import {
  createClique,
  listCliques,
  getClique,
  dissolveClique,
  createCliqueRun,
  updateCliqueRun,
  formCliqueFromCapabilities,
} from "../../agents/clique.js";
import { WorkspaceAwareRequest } from "../../gateway/middleware/workspace.js";
import { AuthenticatedRequest } from "../middleware/auth.js";

const CreateCliqueBody = z.object({
  name: z.string().min(1),
  agentIds: z.array(z.string()).min(1),
  coordinatorAgentId: z.string().min(1),
  description: z.string().optional(),
});

const FormCliqueBody = z.object({
  requiredTools: z.array(z.string()),
  requiredSkills: z.array(z.string()),
  maxSize: z.number().int().positive().optional(),
});

const CreateRunBody = z.object({
  task: z.string().min(1),
});

const UpdateRunBody = z.object({
  status: z.enum(["pending", "running", "done", "failed"]),
  result: z.string().optional(),
});

export function createCliquesRouter(): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
    if (!workspaceId) return res.status(400).json({ error: "workspace required" });

    const cliques = await listCliques(workspaceId);
    res.json(cliques);
  });

  router.get("/:id", async (req, res) => {
    const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
    if (!workspaceId) return res.status(400).json({ error: "workspace required" });

    const clique = await getClique(req.params["id"]!, workspaceId);
    if (!clique) return res.status(404).json({ error: "not found" });
    res.json(clique);
  });

  router.post("/", async (req, res) => {
    const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
    if (!workspaceId) return res.status(400).json({ error: "workspace required" });

    const parsed = CreateCliqueBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { name, agentIds, coordinatorAgentId, description } = parsed.data;
    const { uid } = req as unknown as AuthenticatedRequest;
    const clique = await createClique(workspaceId, name, agentIds, coordinatorAgentId, uid, description);
    res.status(201).json(clique);
  });

  router.post("/form", async (req, res) => {
    const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
    if (!workspaceId) return res.status(400).json({ error: "workspace required" });

    const parsed = FormCliqueBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { requiredTools, requiredSkills, maxSize } = parsed.data;
    const agentIds = await formCliqueFromCapabilities(requiredTools, requiredSkills, maxSize ?? 5);
    res.json({ agentIds });
  });

  router.post("/:id/runs", async (req, res) => {
    const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
    if (!workspaceId) return res.status(400).json({ error: "workspace required" });

    const parsed = CreateRunBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const run = await createCliqueRun(req.params["id"]!, parsed.data.task);
    res.status(201).json(run);
  });

  router.patch("/:id/runs/:runId", async (req, res) => {
    const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
    if (!workspaceId) return res.status(400).json({ error: "workspace required" });

    const parsed = UpdateRunBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { status, result } = parsed.data;
    await updateCliqueRun(req.params["runId"]!, status, result);
    res.json({ ok: true });
  });

  router.delete("/:id", async (req, res) => {
    const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
    if (!workspaceId) return res.status(400).json({ error: "workspace required" });

    const dissolved = await dissolveClique(req.params["id"]!, workspaceId);
    res.json({ dissolved });
  });

  return router;
}
