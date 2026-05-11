import { Router } from "express";
import { z } from "zod";
import {
  snapshotVersion,
  listVersions,
  getVersion,
  purgeOldVersions,
} from "../../memory/versions.js";
import { WorkspaceAwareRequest } from "../../gateway/middleware/workspace.js";
import { AuthenticatedRequest } from "../middleware/auth.js";

const PostBodySchema = z.object({
  memoryId: z.string(),
  memoryTable: z.string(),
  content: z.unknown(),
});

export function createMemoryVersionsRouter(): Router {
  const router = Router();

  router.get("/:table/:memoryId", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });

      const { table, memoryId } = req.params;
      const versions = await listVersions(workspaceId, memoryId, table);
      return res.json(versions);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  router.get("/:table/:memoryId/:version", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });

      const { table, memoryId } = req.params;
      const version = parseInt(req.params["version"], 10);
      const record = await getVersion(workspaceId, memoryId, table, version);
      if (record === null) return res.status(404).json({ error: "not found" });
      return res.json(record);
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

      const { memoryId, memoryTable, content } = parsed.data;
      const uid = (req as unknown as AuthenticatedRequest).uid;

      const result = await snapshotVersion(workspaceId, memoryId, memoryTable, content, uid);
      return res.status(201).json(result);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  router.delete("/:table/:memoryId/purge", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });

      const { table, memoryId } = req.params;
      const keepLatest =
        req.query["keepLatest"] !== undefined ? Number(req.query["keepLatest"]) : 10;
      const deleted = await purgeOldVersions(workspaceId, memoryId, table, keepLatest);
      return res.json({ deleted });
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
