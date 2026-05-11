import { Router } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../../gateway/middleware/workspace.js";
import {
  registerFederationNode,
  listFederationNodes,
  getFederationNode,
  updateNodeStatus,
  getSyncHistory,
} from "../../memory/federation.js";

export function createMemoryFederationRouter(): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const nodes = await listFederationNodes(workspaceId);
      return res.json(nodes);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  router.get("/:id", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const node = await getFederationNode(req.params.id, workspaceId);
      if (!node) return res.status(404).json({ error: "not found" });
      return res.json(node);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  router.get("/:id/history", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const history = await getSyncHistory(req.params.id, workspaceId, 20);
      return res.json(history);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  const RegisterNodeBody = z.object({
    peerWorkspaceId: z.string(),
    peerEndpoint: z.string(),
    trustLevel: z.enum(["read", "read-write"]).optional(),
  });

  router.post("/", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const parsed = RegisterNodeBody.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
      const { peerWorkspaceId, peerEndpoint, trustLevel } = parsed.data;
      const node = await registerFederationNode(workspaceId, peerWorkspaceId, peerEndpoint, trustLevel ?? "read");
      return res.status(201).json(node);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  const UpdateStatusBody = z.object({
    status: z.enum(["active", "paused", "revoked"]),
  });

  router.patch("/:id/status", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const parsed = UpdateStatusBody.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
      const { status } = parsed.data;
      await updateNodeStatus(req.params.id, workspaceId, status);
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
