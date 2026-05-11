import { Router } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../../gateway/middleware/workspace.js";
import {
  createExportJob,
  listExportJobs,
  getExportJob,
  updateExportJob,
  type VectorExportTarget,
} from "../../memory/vector-export.js";

export function createVectorExportRouter(): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const limit = req.query.limit !== undefined ? Number(req.query.limit) : 20;
      const jobs = await listExportJobs(workspaceId, limit);
      return res.json(jobs);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  router.get("/:id", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const job = await getExportJob(req.params.id, workspaceId);
      if (!job) return res.status(404).json({ error: "not found" });
      return res.json(job);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  const CreateExportJobBody = z.object({
    target: z.enum(["pinecone", "weaviate", "qdrant"]),
    targetConfig: z.record(z.string(), z.unknown()),
  });

  router.post("/", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const parsed = CreateExportJobBody.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
      const { target, targetConfig } = parsed.data;
      const job = await createExportJob(workspaceId, target as VectorExportTarget, targetConfig);
      return res.status(201).json(job);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  const UpdateExportJobBody = z.object({
    status: z.enum(["pending", "running", "done", "failed"]),
    recordsExported: z.number().optional(),
    errorMessage: z.string().optional(),
  });

  router.patch("/:id", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const parsed = UpdateExportJobBody.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
      const { status, recordsExported, errorMessage } = parsed.data;
      await updateExportJob(req.params.id, status, { recordsExported, errorMessage });
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
