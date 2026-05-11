import { Router } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import {
  saveTemplate,
  listTemplates,
  getTemplate,
  deleteTemplate,
} from "../../security/workspace-templates.js";

const CreateBody = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
});

export function createWorkspaceTemplatesRouter(): Router {
  const router = Router();

  router.get("/workspace/templates", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    const templates = await listTemplates(workspaceId);
    res.json({ templates });
  });

  router.post("/workspace/templates", async (req, res) => {
    const body = CreateBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: body.error.issues }); return; }
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    const uid = (req as unknown as AuthenticatedRequest).uid;
    const template = await saveTemplate(workspaceId, body.data.name, body.data.description, uid);
    res.status(201).json(template);
  });

  router.get("/workspace/templates/:id", async (req, res) => {
    const { id } = req.params as { id: string };
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    const template = await getTemplate(id, workspaceId);
    if (!template) { res.status(404).json({ error: "Template not found" }); return; }
    res.json(template);
  });

  router.delete("/workspace/templates/:id", async (req, res) => {
    const { id } = req.params as { id: string };
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    const deleted = await deleteTemplate(id, workspaceId);
    if (!deleted) { res.status(404).json({ error: "Template not found" }); return; }
    res.json({ deleted: true });
  });

  return router;
}
