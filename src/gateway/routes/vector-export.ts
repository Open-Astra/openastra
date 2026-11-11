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
import { requireOwned } from "../middleware/ownership.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("vector-export");
const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

export function createVectorExportRouter(): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const q = ListQuery.safeParse(req.query);
      if (!q.success) return res.status(400).json({ error: "Invalid limit" });
      const jobs = await listExportJobs(workspaceId, q.data.limit);
      return res.json(jobs);
    } catch (err) {
      log.error("Request failed:", err);
      return res.status(500).json({ error: "Vector export request failed" });
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
      log.error("Request failed:", err);
      return res.status(500).json({ error: "Vector export request failed" });
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
      log.error("Request failed:", err);
      return res.status(500).json({ error: "Vector export request failed" });
    }
  });

  const UpdateExportJobBody = z.object({
    status: z.enum(["pending", "running", "done", "failed"]),
    recordsExported: z.number().int().min(0).optional(),
    errorMessage: z.string().max(4000).optional(),
  });

  router.patch("/:id", requireOwned("vectorExportJob"), async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const parsed = UpdateExportJobBody.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
      const { status, recordsExported, errorMessage } = parsed.data;
      await updateExportJob(req.params.id as string, status, { recordsExported, errorMessage });
      return res.json({ ok: true });
    } catch (err) {
      log.error("Request failed:", err);
      return res.status(500).json({ error: "Vector export request failed" });
    }
  });

  return router;
}
