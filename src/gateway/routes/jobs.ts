import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { enqueueJob, listJobs, getJob, cancelJob } from "../../jobs/queue.js";

const EnqueueJobBody = z.object({
  type: z.string().min(1).max(128),
  payload: z.record(z.string(), z.unknown()).default({}),
  maxRetries: z.number().int().min(0).max(10).optional(),
  timeoutSeconds: z.number().int().min(10).max(86400).optional(),
});

const ListJobsQuery = z.object({
  status: z.enum(["pending", "running", "completed", "failed", "cancelled"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export function createJobsRouter(): Router {
  const router = Router();

  // POST /jobs — enqueue a new job
  router.post("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = EnqueueJobBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    try {
      const job = await enqueueJob(
        parsed.data.type,
        parsed.data.payload,
        workspaceId,
        { maxRetries: parsed.data.maxRetries, timeoutSeconds: parsed.data.timeoutSeconds },
      );
      res.status(202).json({ id: job.id, status: job.status });
    } catch (err) {
      console.error("[jobs] Enqueue:", err);
      res.status(500).json({ error: "Failed to enqueue job" });
    }
  });

  // GET /jobs — list jobs for workspace
  router.get("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.json({ jobs: [] });
      return;
    }

    const parsed = ListJobsQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.format() });
      return;
    }

    try {
      const jobs = await listJobs(workspaceId, {
        status: parsed.data.status,
        limit: parsed.data.limit,
      });
      res.json({ jobs });
    } catch (err) {
      console.error("[jobs] List:", err);
      res.status(500).json({ error: "Failed to list jobs" });
    }
  });

  // GET /jobs/:id — get job by id
  router.get("/:id", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    try {
      const job = await getJob(req.params.id as string, workspaceId);
      if (!job) {
        res.status(404).json({ error: "Job not found" });
        return;
      }
      res.json({ job });
    } catch (err) {
      console.error("[jobs] Get:", err);
      res.status(500).json({ error: "Failed to get job" });
    }
  });

  // DELETE /jobs/:id — cancel a pending job
  router.delete("/:id", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    try {
      const cancelled = await cancelJob(req.params.id as string, workspaceId);
      if (!cancelled) {
        res.status(404).json({ error: "Job not found or not pending" });
        return;
      }
      res.json({ message: "Job cancelled" });
    } catch (err) {
      console.error("[jobs] Cancel:", err);
      res.status(500).json({ error: "Failed to cancel job" });
    }
  });

  return router;
}
