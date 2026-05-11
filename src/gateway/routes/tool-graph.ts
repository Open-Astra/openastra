import { Router, type Request, type Response } from "express";
import { buildToolDependencyGraph } from "../../tools/dependency-graph.js";

export function createToolGraphRouter(): Router {
  const router = Router();

  router.get("/dependency-graph", (_req: Request, res: Response) => {
    try {
      const graph = buildToolDependencyGraph();
      res.json({ graph });
    } catch (err) {
      console.error("[tool-graph]", err);
      res.status(500).json({ error: "Failed to build dependency graph" });
    }
  });

  return router;
}
