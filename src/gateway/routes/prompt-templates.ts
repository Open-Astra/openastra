import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { getPool } from "../../config/postgres.js";
import { jwtAuth } from "../middleware/auth.js";
import { workspaceResolver } from "../middleware/workspace.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  renderTemplate,
  trackTemplateUsage,
} from "../../agents/prompt-template-library.js";

// ── Prompt Templates Router ───────────────────────────────────────────
// CRUD for workspace-scoped prompt templates + render endpoint.

const CreateTemplateBody = z.object({
  name: z.string().min(1).max(200),
  category: z.string().min(1).max(100).optional(),
  template: z.string().min(1),
  variables: z.array(z.string()).optional(),
});

const UpdateTemplateBody = z.object({
  name: z.string().min(1).max(200).optional(),
  category: z.string().min(1).max(100).optional(),
  template: z.string().min(1).optional(),
  variables: z.array(z.string()).optional(),
});

const RenderBody = z.object({
  variables: z.record(z.string(), z.string()),
});

const ListQuery = z.object({
  category: z.string().optional(),
});

export function createPromptTemplatesRouter(): Router {
  const router = Router();
  router.use(jwtAuth(), workspaceResolver());

  // GET /prompt-templates
  router.get("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.format() });
      return;
    }

    try {
      const templates = await listTemplates(workspaceId, parsed.data.category, getPool());
      res.json({ templates });
    } catch (err) {
      console.error("[prompt-templates] List:", err);
      res.status(500).json({ error: "Failed to list templates" });
    }
  });

  // GET /prompt-templates/:id
  router.get("/:id", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    try {
      const id = req.params["id"] as string;
      const template = await getTemplate(id, workspaceId, getPool());
      if (!template) {
        res.status(404).json({ error: "Template not found" });
        return;
      }
      res.json({ template });
    } catch (err) {
      console.error("[prompt-templates] Get:", err);
      res.status(500).json({ error: "Failed to get template" });
    }
  });

  // POST /prompt-templates
  router.post("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = CreateTemplateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const uid = (req as AuthenticatedRequest).uid;
    const { name, category, template, variables } = parsed.data;

    try {
      const created = await createTemplate(
        workspaceId,
        name,
        category ?? "general",
        template,
        variables ?? [],
        uid,
        getPool(),
      );
      res.status(201).json({ template: created });
    } catch (err) {
      console.error("[prompt-templates] Create:", err);
      res.status(500).json({ error: "Failed to create template" });
    }
  });

  // PUT /prompt-templates/:id
  router.put("/:id", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = UpdateTemplateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    try {
      const id = req.params["id"] as string;
      const updated = await updateTemplate(id, workspaceId, parsed.data, getPool());
      if (!updated) {
        res.status(404).json({ error: "Template not found" });
        return;
      }
      res.json({ template: updated });
    } catch (err) {
      console.error("[prompt-templates] Update:", err);
      res.status(500).json({ error: "Failed to update template" });
    }
  });

  // DELETE /prompt-templates/:id
  router.delete("/:id", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    try {
      const id = req.params["id"] as string;
      const deleted = await deleteTemplate(id, workspaceId, getPool());
      if (!deleted) {
        res.status(404).json({ error: "Template not found" });
        return;
      }
      res.json({ message: "Template deleted" });
    } catch (err) {
      console.error("[prompt-templates] Delete:", err);
      res.status(500).json({ error: "Failed to delete template" });
    }
  });

  // POST /prompt-templates/:id/render
  router.post("/:id/render", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = RenderBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    try {
      const id = req.params["id"] as string;
      const tmpl = await getTemplate(id, workspaceId, getPool());
      if (!tmpl) {
        res.status(404).json({ error: "Template not found" });
        return;
      }

      const rendered = renderTemplate(tmpl.template, parsed.data.variables);

      // Track usage fire-and-forget
      trackTemplateUsage(tmpl.id, getPool()).catch(() => {});

      res.json({ rendered, templateId: tmpl.id, templateName: tmpl.name });
    } catch (err) {
      console.error("[prompt-templates] Render:", err);
      res.status(500).json({ error: "Failed to render template" });
    }
  });

  return router;
}
