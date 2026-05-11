import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import {
  createScheduledTask,
  getScheduledTasks,
  deleteScheduledTask,
  getScheduledTaskById,
  markTaskRun,
} from "../../agents/scheduled-tasks.js";
import { runAgentLoop } from "../../agents/loop.js";
import { getAgentConfig } from "../../config/agents.js";
import { getInferenceClientForAgent } from "../../inference/factory.js";

const CreateTaskBody = z.object({
  agentId: z.string().min(1),
  prompt: z.string().min(1).max(10000),
  cronExpression: z.string().max(128).optional(),
  runAt: z.string().optional(),
  maxRuns: z.number().int().min(1).optional(),
});

export function createScheduledTasksRouter(): Router {
  const router = Router();

  // GET /scheduled-tasks — list user's tasks
  router.get("/", async (req: Request, res: Response) => {
    const uid = (req as unknown as AuthenticatedRequest).uid;
    const workspace = (req as unknown as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId ?? undefined;

    try {
      const tasks = await getScheduledTasks(uid, workspaceId);
      res.json({ tasks });
    } catch (err) {
      console.error("[scheduled-tasks] List:", err);
      res.status(500).json({ error: "Failed to list scheduled tasks" });
    }
  });

  // POST /scheduled-tasks — create a new scheduled task
  router.post("/", async (req: Request, res: Response) => {
    const uid = (req as unknown as AuthenticatedRequest).uid;
    const workspace = (req as unknown as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId ?? undefined;

    const parsed = CreateTaskBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const { agentId, prompt, cronExpression, runAt, maxRuns } = parsed.data;

    if (!cronExpression && !runAt) {
      res.status(400).json({ error: "Either cronExpression or runAt is required" });
      return;
    }

    try {
      const task = await createScheduledTask(uid, {
        workspaceId,
        agentId,
        prompt,
        cronExpression,
        runAt,
        maxRuns,
      });
      res.status(201).json(task);
    } catch (err) {
      console.error("[scheduled-tasks] Create:", err);
      res.status(500).json({ error: "Failed to create scheduled task" });
    }
  });

  // DELETE /scheduled-tasks/:id — delete a task
  router.delete("/:id", async (req: Request, res: Response) => {
    const uid = (req as unknown as AuthenticatedRequest).uid;
    const taskId = req.params.id as string;

    try {
      const deleted = await deleteScheduledTask(uid, taskId);
      if (!deleted) {
        res.status(404).json({ error: "Task not found or not owned by user" });
        return;
      }
      res.json({ deleted: true });
    } catch (err) {
      console.error("[scheduled-tasks] Delete:", err);
      res.status(500).json({ error: "Failed to delete scheduled task" });
    }
  });

  // POST /scheduled-tasks/:id/run — manually trigger a task
  router.post("/:id/run", async (req: Request, res: Response) => {
    const uid = (req as unknown as AuthenticatedRequest).uid;
    const taskId = req.params.id as string;
    const workspace = (req as unknown as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId ?? undefined;

    try {
      const task = await getScheduledTaskById(uid, taskId);
      if (!task) {
        res.status(404).json({ error: "Task not found or not owned by user" });
        return;
      }

      // Resolve agent and run
      let agentConfig;
      try {
        agentConfig = getAgentConfig(task.agentId);
      } catch {
        res.status(404).json({ error: `Agent not found: ${task.agentId}` });
        return;
      }

      const client = getInferenceClientForAgent(agentConfig);
      const result = await runAgentLoop(
        uid,
        task.prompt,
        agentConfig,
        client,
        undefined,
        workspaceId,
      );

      // Mark the task as run
      await markTaskRun(taskId);

      res.json({
        content: result.content,
        sessionId: result.sessionId,
        tokenUsage: result.tokenUsage,
      });
    } catch (err) {
      console.error("[scheduled-tasks] Manual run:", err);
      res.status(500).json({ error: "Failed to run scheduled task" });
    }
  });

  return router;
}
