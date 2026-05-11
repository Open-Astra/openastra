import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { getPool } from "../../config/postgres.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { selectAbVariant, recordAbResult } from "../../agents/ab-test.js";

// ── A/B Test Routes ───────────────────────────────────────────────────
// CRUD for agent_ab_tests + variant selection + result recording.

const CreateAbTestBody = z.object({
  name: z.string().min(1).max(200),
  agentAId: z.string().min(1),
  agentBId: z.string().min(1),
  trafficSplit: z.number().min(0).max(1).default(0.5),
  metric: z.string().default("user_rating"),
});

const RecordResultBody = z.object({
  agentId: z.string().min(1),
  rating: z.number().min(0).max(5),
});

const UpdateAbTestBody = z.object({
  status: z.enum(["active", "paused", "completed"]).optional(),
  trafficSplit: z.number().min(0).max(1).optional(),
});

export function createAbTestsRouter(): Router {
  const router = Router();

  // GET /ab-tests — list all A/B tests for the workspace
  router.get("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const status = typeof req.query.status === "string" ? req.query.status : undefined;

    try {
      const pool = getPool();
      const conditions = ["workspace_id = $1"];
      const values: unknown[] = [workspaceId];
      let idx = 2;

      if (status) {
        conditions.push(`status = $${idx++}`);
        values.push(status);
      }

      const { rows } = await pool.query(
        `SELECT id, workspace_id, name, agent_a_id, agent_b_id,
                traffic_split, metric, status, results, created_at
         FROM agent_ab_tests
         WHERE ${conditions.join(" AND ")}
         ORDER BY created_at DESC`,
        values,
      );
      res.json({ tests: rows });
    } catch (err) {
      console.error("[ab-tests] List:", err);
      res.status(500).json({ error: "Failed to list A/B tests" });
    }
  });

  // POST /ab-tests — create a new A/B test
  router.post("/", async (req: Request, res: Response) => {
    const { uid } = req as AuthenticatedRequest;
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = CreateAbTestBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const { name, agentAId, agentBId, trafficSplit, metric } = parsed.data;

    try {
      const pool = getPool();
      const id = randomUUID();
      const { rows } = await pool.query<{ id: string; created_at: Date }>(
        `INSERT INTO agent_ab_tests
           (id, workspace_id, name, agent_a_id, agent_b_id, traffic_split, metric)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, created_at`,
        [id, workspaceId, name, agentAId, agentBId, trafficSplit, metric],
      );
      void uid; // workspace auth is sufficient
      res.status(201).json({ id: rows[0]!.id, createdAt: rows[0]!.created_at });
    } catch (err) {
      console.error("[ab-tests] Create:", err);
      res.status(500).json({ error: "Failed to create A/B test" });
    }
  });

  // GET /ab-tests/:id — get a single A/B test
  router.get("/:id", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    try {
      const pool = getPool();
      const { rows } = await pool.query(
        `SELECT id, workspace_id, name, agent_a_id, agent_b_id,
                traffic_split, metric, status, results, created_at
         FROM agent_ab_tests
         WHERE id = $1 AND workspace_id = $2`,
        [req.params.id, workspaceId],
      );
      if (rows.length === 0) {
        res.status(404).json({ error: "A/B test not found" });
        return;
      }
      res.json({ test: rows[0] });
    } catch (err) {
      console.error("[ab-tests] Get:", err);
      res.status(500).json({ error: "Failed to get A/B test" });
    }
  });

  // PATCH /ab-tests/:id — update status or traffic split
  router.patch("/:id", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = UpdateAbTestBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (parsed.data.status !== undefined) {
      sets.push(`status = $${idx++}`);
      values.push(parsed.data.status);
    }
    if (parsed.data.trafficSplit !== undefined) {
      sets.push(`traffic_split = $${idx++}`);
      values.push(parsed.data.trafficSplit);
    }

    if (sets.length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }

    values.push(req.params.id, workspaceId);

    try {
      const pool = getPool();
      const result = await pool.query(
        `UPDATE agent_ab_tests SET ${sets.join(", ")}
         WHERE id = $${idx++} AND workspace_id = $${idx++}
         RETURNING id`,
        values,
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: "A/B test not found" });
        return;
      }
      res.json({ message: "Updated" });
    } catch (err) {
      console.error("[ab-tests] Update:", err);
      res.status(500).json({ error: "Failed to update A/B test" });
    }
  });

  // DELETE /ab-tests/:id
  router.delete("/:id", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    try {
      const pool = getPool();
      const result = await pool.query(
        "DELETE FROM agent_ab_tests WHERE id = $1 AND workspace_id = $2 RETURNING id",
        [req.params.id, workspaceId],
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: "A/B test not found" });
        return;
      }
      res.json({ message: "Deleted" });
    } catch (err) {
      console.error("[ab-tests] Delete:", err);
      res.status(500).json({ error: "Failed to delete A/B test" });
    }
  });

  // GET /ab-tests/:id/variant?uid=... — get variant for a user
  router.get("/:id/variant", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const uid = typeof req.query.uid === "string" ? req.query.uid : (req as AuthenticatedRequest).uid;

    try {
      const pool = getPool();
      const { rows } = await pool.query<{
        agent_a_id: string;
        agent_b_id: string;
        traffic_split: string;
        status: string;
      }>(
        "SELECT agent_a_id, agent_b_id, traffic_split, status FROM agent_ab_tests WHERE id = $1 AND workspace_id = $2",
        [req.params.id, workspaceId],
      );
      if (rows.length === 0) {
        res.status(404).json({ error: "A/B test not found" });
        return;
      }
      const test = rows[0]!;
      if (test.status !== "active") {
        res.status(409).json({ error: "A/B test is not active" });
        return;
      }
      const variant = selectAbVariant(
        {
          agent_a_id: test.agent_a_id,
          agent_b_id: test.agent_b_id,
          traffic_split: parseFloat(test.traffic_split),
        },
        uid,
      );
      res.json({ agentId: variant });
    } catch (err) {
      console.error("[ab-tests] Variant:", err);
      res.status(500).json({ error: "Failed to select variant" });
    }
  });

  // POST /ab-tests/:id/results — record a result rating
  router.post("/:id/results", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = RecordResultBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    try {
      const pool = getPool();
      // Verify test belongs to workspace
      const { rows } = await pool.query(
        "SELECT id FROM agent_ab_tests WHERE id = $1 AND workspace_id = $2",
        [req.params.id, workspaceId],
      );
      if (rows.length === 0) {
        res.status(404).json({ error: "A/B test not found" });
        return;
      }
      await recordAbResult(req.params["id"] as string, parsed.data.agentId, parsed.data.rating, pool);
      res.json({ message: "Result recorded" });
    } catch (err) {
      console.error("[ab-tests] Record result:", err);
      res.status(500).json({ error: "Failed to record result" });
    }
  });

  return router;
}
