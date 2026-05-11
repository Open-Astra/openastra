import { Router } from "express";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { exportAsGraphML, exportAsJsonLd, exportAsCypher } from "../../memory/knowledge-graph-export.js";

export function createKnowledgeExportRouter(): Router {
  const router = Router();

  router.get("/memory/export/graphml", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    const uid = (req as unknown as AuthenticatedRequest).uid;
    const userId = (req.query["userId"] as string) ?? uid;
    const xml = await exportAsGraphML(userId, workspaceId);
    res.setHeader("Content-Type", "application/xml");
    res.setHeader("Content-Disposition", `attachment; filename="knowledge-graph.graphml"`);
    res.send(xml);
  });

  router.get("/memory/export/jsonld", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    const uid = (req as unknown as AuthenticatedRequest).uid;
    const userId = (req.query["userId"] as string) ?? uid;
    const jsonld = await exportAsJsonLd(userId, workspaceId);
    res.setHeader("Content-Type", "application/ld+json");
    res.json(jsonld);
  });

  router.get("/memory/export/cypher", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    const uid = (req as unknown as AuthenticatedRequest).uid;
    const userId = (req.query["userId"] as string) ?? uid;
    const cypher = await exportAsCypher(userId, workspaceId);
    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Content-Disposition", `attachment; filename="knowledge-graph.cypher"`);
    res.send(cypher);
  });

  return router;
}
