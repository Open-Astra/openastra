import { Router } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../../gateway/middleware/workspace.js";
import {
  upsertDistilledFact,
  listDistilledFacts,
  deleteDistilledFact,
  purgeExpiredFacts,
  getDistilledFactStats,
} from "../../memory/distillation.js";

export function createKnowledgeDistillationRouter(): Router {
  const router = Router();

  router.get("/stats", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const stats = await getDistilledFactStats(workspaceId);
      return res.json(stats);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  router.get("/", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const uid = req.query.uid as string | undefined;
      if (!uid) return res.status(400).json({ error: "uid is required" });
      const category = req.query.category as string | undefined;
      const minConfidence = req.query.minConfidence !== undefined
        ? Number(req.query.minConfidence)
        : undefined;
      const limit = req.query.limit !== undefined
        ? Number(req.query.limit)
        : undefined;
      const facts = await listDistilledFacts(workspaceId, uid, { category, minConfidence, limit });
      return res.json(facts);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  const UpsertFactBody = z.object({
    uid: z.string(),
    fact: z.string(),
    category: z.string(),
    confidence: z.number().optional(),
    sourceCount: z.number().optional(),
    expiresAt: z.string().optional(),
  });

  router.post("/", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const parsed = UpsertFactBody.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
      const { uid, fact, category, confidence, sourceCount, expiresAt } = parsed.data;
      const result = await upsertDistilledFact(workspaceId, uid, fact, category, {
        confidence,
        sourceCount,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      });
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  router.delete("/purge", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const deleted = await purgeExpiredFacts(workspaceId);
      return res.json({ deleted });
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  router.delete("/:id", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const deleted = await deleteDistilledFact(req.params.id, workspaceId);
      return res.json({ deleted });
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
