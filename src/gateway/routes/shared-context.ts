import { Router } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import {
  addSharedContext,
  getSharedContext,
  removeSharedContext,
} from "../../agents/shared-context.js";

const AddBody = z.object({
  key: z.string().min(1).max(255),
  content: z.string().min(1),
  category: z.enum(["knowledge", "decisions", "projects", "general"]).default("general"),
  priority: z.number().int().min(0).max(1000).default(0),
});

export function createSharedContextRouter(): Router {
  const router = Router();

  // GET /shared-context — list shared context entries
  router.get("/shared-context", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    const category = req.query["category"] as string | undefined;
    const entries = await getSharedContext(workspaceId, { category });
    res.json({ entries });
  });

  // POST /shared-context — add or update entry
  router.post("/shared-context", async (req, res) => {
    const body = AddBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: body.error.issues }); return; }
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    const uid = (req as unknown as AuthenticatedRequest).uid;
    const entry = await addSharedContext(
      workspaceId,
      body.data.key,
      body.data.content,
      body.data.category,
      body.data.priority,
      uid,
    );
    res.status(201).json({ entry });
  });

  // DELETE /shared-context/:key — remove entry
  router.delete("/shared-context/:key", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    const key = req.params["key"];
    if (!key) { res.status(400).json({ error: "Key required" }); return; }
    await removeSharedContext(workspaceId, key);
    res.json({ removed: true });
  });

  return router;
}
