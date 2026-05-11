// ── Route: Conversation Checkpoints ────────────────────────────────────
import { Router } from "express";
import { z } from "zod";
import {
  saveCheckpoint, listCheckpoints, getCheckpoint, deleteCheckpoint,
} from "../../agents/checkpoint.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";

const SaveBody = z.object({
  sessionId: z.string(),
  snapshot: z.array(z.unknown()),
  label: z.string().optional(),
});

export function createCheckpointsRouter(): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
    if (!workspaceId) return res.status(400).json({ error: "workspace required" });
    const sessionId = typeof req.query["sessionId"] === "string" ? req.query["sessionId"] : undefined;
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    const checkpoints = await listCheckpoints(sessionId, workspaceId);
    res.json(checkpoints);
  });

  router.get("/:id", async (req, res) => {
    const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
    if (!workspaceId) return res.status(400).json({ error: "workspace required" });
    const cp = await getCheckpoint(req.params["id"]!, workspaceId);
    if (!cp) return res.status(404).json({ error: "not found" });
    res.json(cp);
  });

  router.post("/", async (req, res) => {
    const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
    if (!workspaceId) return res.status(400).json({ error: "workspace required" });
    const uid = (req as unknown as AuthenticatedRequest).uid;
    const parse = SaveBody.safeParse(req.body);
    if (!parse.success) return res.status(400).json({ error: parse.error.flatten() });
    const { sessionId, snapshot, label } = parse.data;
    const cp = await saveCheckpoint(sessionId, workspaceId, snapshot, uid, label);
    res.status(201).json(cp);
  });

  router.delete("/:id", async (req, res) => {
    const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
    if (!workspaceId) return res.status(400).json({ error: "workspace required" });
    const deleted = await deleteCheckpoint(req.params["id"]!, workspaceId);
    res.json({ deleted });
  });

  return router;
}
