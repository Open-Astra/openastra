import { Router } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import {
  createQueue, getQueues, deleteQueue, enqueue, dequeue,
  completeTask, failTask, stealTask, getTasks,
} from "../../agents/work-queue.js";

const QueueBody = z.object({
  name: z.string(),
  teamId: z.string().optional(),
  maxDepth: z.number().int().positive().optional(),
});

const TaskBody = z.object({
  name: z.string(),
  payload: z.unknown().optional(),
  priority: z.number().int().min(1).max(5).optional(),
  deadline: z.string().datetime().optional(),
});

export function createWorkQueuesRouter(): Router {
  const router = Router();

  router.post("/work-queues", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    const parsed = QueueBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const queue = await createQueue(workspaceId, parsed.data.name, parsed.data);
    res.status(201).json(queue);
  });

  router.get("/work-queues", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    res.json({ queues: await getQueues(workspaceId) });
  });

  router.get("/work-queues/:id", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    const queues = await getQueues(workspaceId);
    const q = queues.find((q) => q.id === req.params.id);
    if (!q) return res.status(404).json({ error: "Queue not found" });
    res.json(q);
  });

  router.delete("/work-queues/:id", async (req, res) => {
    await deleteQueue(req.params.id);
    res.json({ deleted: true });
  });

  router.post("/work-queues/:id/tasks", async (req, res) => {
    const parsed = TaskBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const task = await enqueue(req.params.id, {
      ...parsed.data,
      deadline: parsed.data.deadline ? new Date(parsed.data.deadline) : undefined,
    });
    res.status(201).json(task);
  });

  router.post("/work-queues/:id/dequeue", async (req, res) => {
    const { agentId } = req.body;
    if (!agentId) return res.status(400).json({ error: "agentId required" });
    const task = await dequeue(req.params.id, agentId);
    if (!task) return res.status(204).send();
    res.json(task);
  });

  router.post("/work-queues/:id/steal", async (req, res) => {
    const { agentId } = req.body;
    if (!agentId) return res.status(400).json({ error: "agentId required" });
    const task = await stealTask(req.params.id, agentId);
    if (!task) return res.status(204).send();
    res.json(task);
  });

  router.get("/work-queues/:id/tasks", async (req, res) => {
    const status = req.query["status"] ? String(req.query["status"]) : undefined;
    res.json({ tasks: await getTasks(req.params.id, status) });
  });

  router.post("/work-queue-tasks/:id/complete", async (req, res) => {
    await completeTask(req.params.id, req.body.result);
    res.json({ completed: true });
  });

  router.post("/work-queue-tasks/:id/fail", async (req, res) => {
    const { error } = req.body;
    if (!error) return res.status(400).json({ error: "error message required" });
    await failTask(req.params.id, error);
    res.json({ failed: true });
  });

  return router;
}
