import { Router } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import {
  createQueue, getQueues, deleteQueue, enqueue, dequeue,
  completeTask, failTask, stealTask, getTasks,
} from "../../agents/work-queue.js";
import { requireOwned } from "../middleware/ownership.js";

const AgentBody = z.object({ agentId: z.string().min(1).max(128) });
const CompleteBody = z.object({ result: z.unknown().optional() });
const FailBody = z.object({ error: z.string().min(1).max(4000) });
const TASK_STATUSES = z.enum(["pending", "assigned", "completed", "failed"]);

const QueueBody = z.object({
  name: z.string().min(1).max(200),
  teamId: z.string().max(128).optional(),
  maxDepth: z.number().int().positive().optional(),
});

const TaskBody = z.object({
  name: z.string().min(1).max(200),
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
    const q = queues.find((q) => q.id === (req.params.id as string));
    if (!q) return res.status(404).json({ error: "Queue not found" });
    res.json(q);
  });

  router.delete("/work-queues/:id", requireOwned("workQueue"), async (req, res) => {
    await deleteQueue((req.params.id as string));
    res.json({ deleted: true });
  });

  router.post("/work-queues/:id/tasks", requireOwned("workQueue"), async (req, res) => {
    const parsed = TaskBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const task = await enqueue((req.params.id as string), {
      ...parsed.data,
      deadline: parsed.data.deadline ? new Date(parsed.data.deadline) : undefined,
    });
    res.status(201).json(task);
  });

  router.post("/work-queues/:id/dequeue", requireOwned("workQueue"), async (req, res) => {
    const body = AgentBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "agentId required" });
    const { agentId } = body.data;
    const task = await dequeue((req.params.id as string), agentId);
    if (!task) return res.status(204).send();
    res.json(task);
  });

  router.post("/work-queues/:id/steal", requireOwned("workQueue"), async (req, res) => {
    const body = AgentBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "agentId required" });
    const { agentId } = body.data;
    const task = await stealTask((req.params.id as string), agentId);
    if (!task) return res.status(204).send();
    res.json(task);
  });

  router.get("/work-queues/:id/tasks", requireOwned("workQueue"), async (req, res) => {
    const statusParsed = TASK_STATUSES.optional().safeParse(req.query["status"]);
    if (!statusParsed.success) return res.status(400).json({ error: "Invalid status" });
    const status = statusParsed.data;
    res.json({ tasks: await getTasks((req.params.id as string), status) });
  });

  router.post("/work-queue-tasks/:id/complete", requireOwned("workQueueTask"), async (req, res) => {
    const body = CompleteBody.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: body.error.message });
    await completeTask((req.params.id as string), body.data.result);
    res.json({ completed: true });
  });

  router.post("/work-queue-tasks/:id/fail", requireOwned("workQueueTask"), async (req, res) => {
    const body = FailBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "error message required" });
    await failTask((req.params.id as string), body.data.error);
    res.json({ failed: true });
  });

  return router;
}
