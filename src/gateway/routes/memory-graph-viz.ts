// Mount: app.use("/memory/graph-viz", jwtAuth(), workspaceResolver(), createMemoryGraphVizRouter())

import { Router } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { getGraphVizData } from "../../memory/graph-viz.js";

const QuerySchema = z.object({
  uid: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  minWeight: z.coerce.number().min(0).max(10).optional(),
});

export function createMemoryGraphVizRouter(): Router {
  const router = Router();

  // GET /memory/graph-viz?uid=&limit=&minWeight=
  router.get("/", async (req, res) => {
    const r = req as unknown as AuthenticatedRequest & WorkspaceAwareRequest;
    const workspaceId = r.workspace?.workspaceId ?? r.uid;

    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query parameters", details: parsed.error.format() });
      return;
    }

    const { uid, limit, minWeight } = parsed.data;

    try {
      const data = await getGraphVizData(workspaceId, uid, { limit, minWeight });
      res.json(data);
    } catch (err) {
      console.error("[memory-graph-viz] Error:", err);
      res.status(500).json({ error: "Failed to retrieve graph visualization data" });
    }
  });

  return router;
}
