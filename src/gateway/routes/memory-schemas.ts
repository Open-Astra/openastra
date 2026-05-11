import { Router } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../../gateway/middleware/workspace.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import {
  upsertMemorySchema,
  getMemorySchema,
  listMemorySchemas,
  deleteMemorySchema,
  validateMemoryContent,
} from "../../memory/schemas.js";

export function createMemorySchemasRouter(): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const schemas = await listMemorySchemas(workspaceId);
      return res.json(schemas);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  router.get("/:category", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const schema = await getMemorySchema(workspaceId, req.params.category);
      if (!schema) return res.status(404).json({ error: "not found" });
      return res.json(schema);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  const UpsertSchemaBody = z.object({
    category: z.string(),
    schema: z.record(z.string(), z.unknown()),
    strict: z.boolean().optional(),
  });

  router.put("/", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const parsed = UpsertSchemaBody.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
      const { category, schema, strict } = parsed.data;
      const uid = (req as unknown as AuthenticatedRequest).uid;
      const result = await upsertMemorySchema(workspaceId, category, schema, strict ?? false, uid);
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  const ValidateBody = z.object({
    category: z.string(),
    content: z.unknown(),
  });

  router.post("/validate", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const parsed = ValidateBody.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
      const { category, content } = parsed.data;
      const result = await validateMemoryContent(workspaceId, category, content);
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  router.delete("/:category", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const deleted = await deleteMemorySchema(workspaceId, req.params.category);
      return res.json({ deleted });
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
