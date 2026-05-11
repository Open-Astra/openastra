import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { exportWorkspaceMemory, importMemoryBundle, type MemoryBundle } from "../../memory/portable.js";

const MemoryBundleSchema = z.object({
  workspaceId: z.string().min(1),
  exportedAt: z.string(),
  dailyMemory: z.array(z.unknown()),
  graphEntities: z.array(z.unknown()),
  graphRelations: z.array(z.unknown()),
});

export function createMemoryPortableRouter(): Router {
  const router = Router();

  // GET /export — export workspace memory as JSON bundle
  router.get("/export", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    try {
      const bundle = await exportWorkspaceMemory(workspaceId);
      res.json(bundle);
    } catch (err) {
      console.error("[memory-portable] Export:", err);
      res.status(500).json({ error: "Failed to export memory" });
    }
  });

  // POST /import — import a memory bundle
  router.post("/import", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = MemoryBundleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid bundle format", details: parsed.error.format() });
      return;
    }

    try {
      const result = await importMemoryBundle(workspaceId, parsed.data as MemoryBundle);
      res.json(result);
    } catch (err) {
      console.error("[memory-portable] Import:", err);
      res.status(500).json({ error: "Failed to import memory bundle" });
    }
  });

  return router;
}
