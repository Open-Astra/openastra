import { Router } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import {
  createTaskNode, addDependency, getExecutionOrder, detectCycles, completeNode, deleteNode,
} from "../../agents/dependency-graph.js";
import { getPool } from "../../config/postgres.js";

const NodeBody = z.object({
  name: z.string(),
  agentId: z.string(),
  payload: z.unknown().optional(),
});

const EdgeBody = z.object({
  fromNodeId: z.string().uuid(),
  toNodeId: z.string().uuid(),
});

export function createDependencyGraphRouter(): Router {
  const router = Router();

  router.post("/dependency-graph/nodes", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    const parsed = NodeBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const node = await createTaskNode(workspaceId, parsed.data);
    res.status(201).json(node);
  });

  router.get("/dependency-graph/nodes", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT id, name, agent_id AS "agentId", status, payload, created_at AS "createdAt"
       FROM task_graph_nodes WHERE workspace_id = $1 ORDER BY created_at`,
      [workspaceId],
    );
    res.json({ nodes: rows });
  });

  router.post("/dependency-graph/edges", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    const parsed = EdgeBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    await addDependency(workspaceId, parsed.data.fromNodeId, parsed.data.toNodeId);
    res.status(201).json({ added: true });
  });

  router.get("/dependency-graph/plan", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    const plan = await getExecutionOrder(workspaceId);
    res.json(plan);
  });

  router.get("/dependency-graph/cycles", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    const cycles = await detectCycles(workspaceId);
    res.json({ cycles, hasCycles: cycles.length > 0 });
  });

  router.post("/dependency-graph/nodes/:id/complete", async (req, res) => {
    await completeNode(req.params.id);
    res.json({ completed: true });
  });

  router.delete("/dependency-graph/nodes/:id", async (req, res) => {
    await deleteNode(req.params.id);
    res.json({ deleted: true });
  });

  return router;
}
