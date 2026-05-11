import { Router } from "express";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { diffMemoryState, getMemoryChangelog } from "../../memory/diff.js";

export function createMemoryDiffRouter(): Router {
  const router = Router();

  router.get("/memory/diff", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    const uid = (req as unknown as AuthenticatedRequest).uid;
    const userId = (req.query["userId"] as string) ?? uid;
    const from = req.query["from"] ? new Date(String(req.query["from"])) : new Date(Date.now() - 7 * 86400 * 1000);
    const to = req.query["to"] ? new Date(String(req.query["to"])) : new Date();

    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      res.status(400).json({ error: "Invalid from/to date" });
      return;
    }

    const diff = await diffMemoryState(userId, from, to, workspaceId ?? undefined);
    res.json(diff);
  });

  router.get("/memory/changelog", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    const uid = (req as unknown as AuthenticatedRequest).uid;
    const userId = (req.query["userId"] as string) ?? uid;
    const days = Math.min(parseInt(String(req.query["days"] ?? "7"), 10), 90);

    const changelog = await getMemoryChangelog(userId, days, workspaceId ?? undefined);
    res.json({ changelog, days });
  });

  return router;
}
