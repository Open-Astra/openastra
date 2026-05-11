import { Router } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../../gateway/middleware/workspace.js";
import {
  createCluster,
  listClusters,
  getCluster,
  addClusterMember,
  getClusterMembers,
  archiveCluster,
} from "../../memory/clustering.js";

export function createMemoryClustersRouter(): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const clusters = await listClusters(workspaceId);
      return res.json(clusters);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  router.get("/:id", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const cluster = await getCluster(req.params.id, workspaceId);
      if (!cluster) return res.status(404).json({ error: "not found" });
      return res.json(cluster);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  router.get("/:id/members", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const members = await getClusterMembers(req.params.id, workspaceId);
      return res.json(members);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  const CreateClusterBody = z.object({
    label: z.string(),
    centroidVector: z.array(z.number()),
    description: z.string().optional(),
  });

  router.post("/", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const parsed = CreateClusterBody.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
      const { label, centroidVector, description } = parsed.data;
      const cluster = await createCluster(workspaceId, label, centroidVector, description);
      return res.status(201).json(cluster);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  const AddMemberBody = z.object({
    memoryId: z.string(),
    memoryTable: z.string(),
    similarity: z.number().min(0).max(1),
  });

  router.post("/:id/members", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const parsed = AddMemberBody.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
      const { memoryId, memoryTable, similarity } = parsed.data;
      await addClusterMember(req.params.id, memoryId, memoryTable, similarity);
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  router.delete("/:id", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const archived = await archiveCluster(req.params.id, workspaceId);
      return res.json({ archived });
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
