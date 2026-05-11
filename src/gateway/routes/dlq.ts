import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import {
  listDlqEntries,
  replayDlqEntry,
  resolveDlqEntry,
  getDLQJobs,
  retryDLQJob,
  purgeDLQ,
} from "../../jobs/dlq.js";

// ── Dead Letter Queue Router ─────────────────────────────────────────
// GET    /jobs/dlq              — list DLQ entries (paginated)
// POST   /jobs/dlq/:id/replay   — re-enqueue a failed job (legacy)
// POST   /jobs/dlq/:id/retry    — move DLQ entry back to main queue
// POST   /jobs/dlq/:id/resolve  — dismiss a failed job without replaying
// DELETE /jobs/dlq/purge        — purge old entries by age

const ListDlqQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const PurgeQuery = z.object({
  olderThanDays: z.coerce.number().int().min(1).default(30),
});

export function createDlqRouter(): Router {
  const router = Router();

  // GET /jobs/dlq — list DLQ entries (paginated, workspace-scoped if available)
  router.get("/", async (req: Request, res: Response) => {
    const workspace = (req as unknown as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;

    const parsed = ListDlqQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.format() });
      return;
    }

    try {
      // If workspace is present, use workspace-scoped list; otherwise use global paginated list
      if (workspaceId) {
        const entries = await listDlqEntries(workspaceId, parsed.data.limit);
        res.json({ entries, total: entries.length });
      } else {
        const result = await getDLQJobs(parsed.data.limit, parsed.data.offset);
        res.json(result);
      }
    } catch (err) {
      console.error("[dlq] List:", err);
      res.status(500).json({ error: "Failed to list DLQ entries" });
    }
  });

  // POST /jobs/dlq/:id/retry — move DLQ entry back to main queue for retry
  router.post("/:id/retry", async (req: Request, res: Response) => {
    const entryId = req.params.id as string;

    try {
      const newJobId = await retryDLQJob(entryId);
      res.json({ message: "Job retried", newJobId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to retry DLQ entry";
      if (msg.includes("not found")) {
        res.status(404).json({ error: msg });
        return;
      }
      console.error("[dlq] Retry:", err);
      res.status(500).json({ error: "Failed to retry DLQ entry" });
    }
  });

  // POST /jobs/dlq/:id/replay — re-enqueue a failed job (legacy endpoint)
  router.post("/:id/replay", async (req: Request, res: Response) => {
    const workspace = (req as unknown as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;

    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const entryId = req.params.id as string;

    try {
      await replayDlqEntry(entryId);
      res.json({ message: "Job replayed" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to replay DLQ entry";
      if (msg.includes("not found")) {
        res.status(404).json({ error: msg });
        return;
      }
      console.error("[dlq] Replay:", err);
      res.status(500).json({ error: "Failed to replay DLQ entry" });
    }
  });

  // POST /jobs/dlq/:id/resolve — mark DLQ entry as resolved
  router.post("/:id/resolve", async (req: Request, res: Response) => {
    const entryId = req.params.id as string;

    try {
      await resolveDlqEntry(entryId);
      res.json({ message: "DLQ entry resolved" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to resolve DLQ entry";
      if (msg.includes("not found")) {
        res.status(404).json({ error: msg });
        return;
      }
      console.error("[dlq] Resolve:", err);
      res.status(500).json({ error: "Failed to resolve DLQ entry" });
    }
  });

  // DELETE /jobs/dlq/purge — purge old DLQ entries
  router.delete("/purge", async (req: Request, res: Response) => {
    const parsed = PurgeQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.format() });
      return;
    }

    try {
      const deleted = await purgeDLQ(parsed.data.olderThanDays);
      res.json({ message: "DLQ purged", deleted, olderThanDays: parsed.data.olderThanDays });
    } catch (err) {
      console.error("[dlq] Purge:", err);
      res.status(500).json({ error: "Failed to purge DLQ" });
    }
  });

  return router;
}
