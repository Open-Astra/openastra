import { Router } from "express";
import { z } from "zod";
import {
  setMemoryACL,
  getMemoryACL,
  deleteMemoryACL,
  listWorkspaceACLs,
  MemoryVisibility,
} from "../../memory/acl.js";
import { WorkspaceAwareRequest } from "../../gateway/middleware/workspace.js";
import { AuthenticatedRequest } from "../middleware/auth.js";

const PutBodySchema = z.object({
  memoryId: z.string(),
  memoryTable: z.string(),
  visibility: z.enum(["private", "workspace", "cross-workspace"]),
  allowedUids: z.array(z.string()).optional(),
});

export function createMemoryAclRouter(): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });

      const limit = req.query["limit"] !== undefined ? Number(req.query["limit"]) : 50;
      const acls = await listWorkspaceACLs(workspaceId, limit);
      return res.json(acls);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  router.get("/:table/:memoryId", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });

      const { table, memoryId } = req.params;
      const acl = await getMemoryACL(workspaceId, memoryId, table);
      if (acl === null) return res.status(404).json({ error: "not found" });
      return res.json(acl);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  router.put("/", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });

      const parsed = PutBodySchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

      const { memoryId, memoryTable, visibility, allowedUids } = parsed.data;
      const uid = (req as unknown as AuthenticatedRequest).uid;

      const result = await setMemoryACL(
        workspaceId,
        memoryId,
        memoryTable,
        visibility as MemoryVisibility,
        allowedUids ?? [],
        uid,
      );
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  router.delete("/:table/:memoryId", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });

      const { table, memoryId } = req.params;
      const deleted = await deleteMemoryACL(workspaceId, memoryId, table);
      return res.json({ deleted });
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
