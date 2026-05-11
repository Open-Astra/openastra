import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";

export interface TaskNode {
  id: string;
  workspaceId: string;
  name: string;
  agentId: string;
  status: "pending" | "ready" | "running" | "completed" | "failed";
  dependencies: string[];
  dependents: string[];
  payload?: unknown;
  createdAt: Date;
}

export interface ExecutionPlan {
  nodes: TaskNode[];
  criticalPath: string[];
  estimatedParallelism: number;
}

export async function createTaskNode(
  workspaceId: string,
  task: { name: string; agentId: string; payload?: unknown },
): Promise<TaskNode> {
  const id = randomUUID();
  const pool = getPool();
  await pool.query(
    `INSERT INTO task_graph_nodes (id, workspace_id, name, agent_id, payload)
     VALUES ($1,$2,$3,$4,$5)`,
    [id, workspaceId, task.name, task.agentId, task.payload ? JSON.stringify(task.payload) : null],
  );
  return {
    id, workspaceId, name: task.name, agentId: task.agentId,
    status: "pending", dependencies: [], dependents: [], payload: task.payload, createdAt: new Date(),
  };
}

export async function addDependency(workspaceId: string, fromNodeId: string, toNodeId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO task_graph_edges (id, workspace_id, from_node_id, to_node_id)
     VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [randomUUID(), workspaceId, fromNodeId, toNodeId],
  );
}

export async function getExecutionOrder(workspaceId: string): Promise<ExecutionPlan> {
  const pool = getPool();
  const { rows: nodeRows } = await pool.query(
    `SELECT id, workspace_id AS "workspaceId", name, agent_id AS "agentId", status,
            payload, created_at AS "createdAt"
     FROM task_graph_nodes WHERE workspace_id = $1`,
    [workspaceId],
  );
  const { rows: edgeRows } = await pool.query(
    `SELECT from_node_id AS "fromNodeId", to_node_id AS "toNodeId"
     FROM task_graph_edges WHERE workspace_id = $1`,
    [workspaceId],
  );

  const nodes: TaskNode[] = nodeRows.map((r) => ({
    ...r,
    dependencies: edgeRows.filter((e) => e.toNodeId === r.id).map((e) => e.fromNodeId),
    dependents: edgeRows.filter((e) => e.fromNodeId === r.id).map((e) => e.toNodeId),
  })) as TaskNode[];

  // Topological sort (Kahn's algorithm)
  const inDegree = new Map<string, number>();
  nodes.forEach((n) => inDegree.set(n.id, n.dependencies.length));
  const queue = nodes.filter((n) => inDegree.get(n.id) === 0).map((n) => n.id);
  const sorted: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);
    const node = nodes.find((n) => n.id === current)!;
    for (const dep of node.dependents) {
      inDegree.set(dep, (inDegree.get(dep) ?? 1) - 1);
      if (inDegree.get(dep) === 0) queue.push(dep);
    }
  }

  // Critical path = longest path through the DAG
  const depth = new Map<string, number>();
  for (const id of sorted) {
    const node = nodes.find((n) => n.id === id)!;
    const maxDepDep = node.dependencies.length > 0
      ? Math.max(...node.dependencies.map((d) => depth.get(d) ?? 0))
      : 0;
    depth.set(id, maxDepDep + 1);
  }
  const maxDepth = Math.max(0, ...depth.values());
  const criticalPath = sorted.filter((id) => depth.get(id) === maxDepth);

  const sortedNodes = sorted.map((id) => nodes.find((n) => n.id === id)!);
  const levels = new Set(depth.values()).size;
  const estimatedParallelism = levels > 0 ? Math.round(nodes.length / levels) : 1;

  return { nodes: sortedNodes, criticalPath, estimatedParallelism };
}

export async function detectCycles(workspaceId: string): Promise<string[][]> {
  const plan = await getExecutionOrder(workspaceId);
  const pool = getPool();
  const { rows: allNodes } = await pool.query(
    `SELECT id FROM task_graph_nodes WHERE workspace_id = $1`,
    [workspaceId],
  );
  const sortedIds = new Set(plan.nodes.map((n) => n.id));
  const cycleNodes = allNodes.filter((n) => !sortedIds.has(n.id)).map((n) => n.id);
  return cycleNodes.length > 0 ? [cycleNodes] : [];
}

export async function completeNode(nodeId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE task_graph_nodes SET status = 'completed', completed_at = now() WHERE id = $1`,
    [nodeId],
  );
  // Check if downstream nodes are now ready
  const { rows: edges } = await pool.query(
    `SELECT to_node_id FROM task_graph_edges WHERE from_node_id = $1`,
    [nodeId],
  );
  for (const edge of edges) {
    const { rows: deps } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM task_graph_edges e
       JOIN task_graph_nodes n ON n.id = e.from_node_id
       WHERE e.to_node_id = $1 AND n.status != 'completed'`,
      [edge.to_node_id],
    );
    if (parseInt(deps[0].cnt, 10) === 0) {
      await pool.query(
        `UPDATE task_graph_nodes SET status = 'ready' WHERE id = $1 AND status = 'pending'`,
        [edge.to_node_id],
      );
    }
  }
}

export async function deleteNode(nodeId: string): Promise<void> {
  const pool = getPool();
  await pool.query(`DELETE FROM task_graph_nodes WHERE id = $1`, [nodeId]);
}
