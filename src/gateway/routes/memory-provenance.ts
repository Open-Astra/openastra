import { Router } from "express";
import { z } from "zod";
import {
  recordProvenance,
  getProvenance,
  getProvenanceBySession,
  getProvenanceSummary,
  ProvenanceSource,
} from "../../memory/provenance.js";
import { WorkspaceAwareRequest } from "../../gateway/middleware/workspace.js";

const PostBodySchema = z.object({
  memoryId: z.string(),
  memoryTable: z.string(),
  source: z.enum(["conversation", "tool", "document", "synthesis", "import"]),
  sessionId: z.string().optional(),
  agentId: z.string().optional(),
  toolName: z.string().optional(),
  documentRef: z.string().optional(),
  confidence: z.number().optional(),
});

export function createMemoryProvenanceRouter(): Router {
  const router = Router();

  router.get("/summary", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });

      const windowDays = req.query["windowDays"] !== undefined ? Number(req.query["windowDays"]) : 7;
      const summary = await getProvenanceSummary(workspaceId, windowDays);
      return res.json(summary);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  router.get("/session/:sessionId", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });

      const { sessionId } = req.params;
      const limit = req.query["limit"] !== undefined ? Number(req.query["limit"]) : 100;
      const records = await getProvenanceBySession(workspaceId, sessionId, limit);
      return res.json(records);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  router.get("/:table/:memoryId", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });

      const { table, memoryId } = req.params;
      const records = await getProvenance(workspaceId, memoryId, table);
      return res.json(records);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  router.post("/", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });

      const parsed = PostBodySchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

      const { memoryId, memoryTable, source, sessionId, agentId, toolName, documentRef, confidence } =
        parsed.data;

      await recordProvenance(workspaceId, memoryId, memoryTable, source as ProvenanceSource, {
        sessionId,
        agentId,
        toolName,
        documentRef,
        confidence,
      });
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
