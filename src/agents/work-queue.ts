import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";

export interface WorkQueue {
  id: string;
  workspaceId: string;
  name: string;
  teamId: string | null;
  maxDepth: number;
  pendingCount: number;
  createdAt: Date;
}

export interface QueueTask {
  id: string;
  queueId: string;
  name: string;
  payload?: unknown;
  priority: number;
  deadline: Date | null;
  assignedTo: string | null;
  status: "pending" | "assigned" | "completed" | "failed";
  result?: unknown;
  error?: string;
  createdAt: Date;
}

export async function createQueue(
  workspaceId: string,
  name: string,
  opts?: { maxDepth?: number; teamId?: string },
): Promise<WorkQueue> {
  const id = randomUUID();
  const pool = getPool();
  await pool.query(
    `INSERT INTO work_queues (id, workspace_id, name, team_id, max_depth) VALUES ($1,$2,$3,$4,$5)`,
    [id, workspaceId, name, opts?.teamId ?? null, opts?.maxDepth ?? 100],
  );
  return { id, workspaceId, name, teamId: opts?.teamId ?? null, maxDepth: opts?.maxDepth ?? 100, pendingCount: 0, createdAt: new Date() };
}

export async function getQueues(workspaceId: string): Promise<WorkQueue[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT q.id, q.workspace_id AS "workspaceId", q.name, q.team_id AS "teamId",
            q.max_depth AS "maxDepth", q.created_at AS "createdAt",
            COUNT(t.id) FILTER (WHERE t.status = 'pending')::int AS "pendingCount"
     FROM work_queues q LEFT JOIN work_queue_tasks t ON t.queue_id = q.id
     WHERE q.workspace_id = $1 GROUP BY q.id ORDER BY q.created_at DESC`,
    [workspaceId],
  );
  return rows as WorkQueue[];
}

export async function deleteQueue(queueId: string): Promise<void> {
  const pool = getPool();
  await pool.query(`DELETE FROM work_queues WHERE id = $1`, [queueId]);
}

export async function enqueue(
  queueId: string,
  task: { name: string; payload?: unknown; priority?: number; deadline?: Date },
): Promise<QueueTask> {
  const id = randomUUID();
  const pool = getPool();
  await pool.query(
    `INSERT INTO work_queue_tasks (id, queue_id, name, payload, priority, deadline)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, queueId, task.name, task.payload ? JSON.stringify(task.payload) : null, task.priority ?? 3, task.deadline ?? null],
  );
  return { id, queueId, name: task.name, payload: task.payload, priority: task.priority ?? 3, deadline: task.deadline ?? null, assignedTo: null, status: "pending", createdAt: new Date() };
}

export async function dequeue(queueId: string, agentId: string): Promise<QueueTask | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `UPDATE work_queue_tasks SET status = 'assigned', assigned_to = $2
     WHERE id = (
       SELECT id FROM work_queue_tasks
       WHERE queue_id = $1 AND status = 'pending'
       ORDER BY priority ASC, deadline ASC NULLS LAST, created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     ) RETURNING id, queue_id AS "queueId", name, payload, priority, deadline,
                 assigned_to AS "assignedTo", status, created_at AS "createdAt"`,
    [queueId, agentId],
  );
  return (rows[0] as QueueTask) ?? null;
}

export async function completeTask(taskId: string, result?: unknown): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE work_queue_tasks SET status = 'completed', result = $2, completed_at = now() WHERE id = $1`,
    [taskId, result ? JSON.stringify(result) : null],
  );
}

export async function failTask(taskId: string, error: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE work_queue_tasks SET status = 'failed', error = $2, completed_at = now() WHERE id = $1`,
    [taskId, error],
  );
}

export async function stealTask(fromQueueId: string, toAgentId: string): Promise<QueueTask | null> {
  return dequeue(fromQueueId, toAgentId);
}

export async function getTasks(queueId: string, status?: string): Promise<QueueTask[]> {
  const pool = getPool();
  const filter = status ? ` AND status = $2` : "";
  const params: unknown[] = [queueId];
  if (status) params.push(status);
  const { rows } = await pool.query(
    `SELECT id, queue_id AS "queueId", name, payload, priority, deadline,
            assigned_to AS "assignedTo", status, result, error, created_at AS "createdAt"
     FROM work_queue_tasks WHERE queue_id = $1${filter}
     ORDER BY priority ASC, created_at ASC`,
    params,
  );
  return rows as QueueTask[];
}
