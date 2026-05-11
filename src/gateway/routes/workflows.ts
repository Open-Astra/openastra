import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { getPool } from "../../config/postgres.js";
import { getInferenceClientForAgent } from "../../inference/factory.js";
import { executeWorkflow } from "../../workflows/engine.js";
import type { WorkflowDefinition } from "../../workflows/engine.js";

// ── Zod Schemas ──────────────────────────────────────────────────────

const WorkflowStepSchema: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      id: z.string(),
      type: z.literal("agent"),
      agentId: z.string(),
      message: z.string(),
      outputVar: z.string(),
    }),
    z.object({
      id: z.string(),
      type: z.literal("tool"),
      toolName: z.string(),
      params: z.record(z.string(), z.unknown()),
      outputVar: z.string(),
    }),
    z.object({
      id: z.string(),
      type: z.literal("condition"),
      expr: z.string(),
      then: z.string(),
      else: z.string(),
    }),
    z.object({
      id: z.string(),
      type: z.literal("parallel"),
      steps: z.array(z.unknown()),
    }),
  ]),
);

const WorkflowDefinitionSchema = z.object({
  steps: z.array(WorkflowStepSchema),
});

const CreateWorkflowBody = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(2000).optional(),
  definition: WorkflowDefinitionSchema,
});

const RunWorkflowBody = z.object({
  input: z.record(z.string(), z.unknown()).default({}),
  uid: z.string().min(1).optional(),
});

// ── Router ───────────────────────────────────────────────────────────

export function createWorkflowsRouter(): Router {
  const router = Router();

  // POST /workflows — create a workflow
  router.post("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = CreateWorkflowBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    try {
      const pool = getPool();
      const result = await pool.query<{ id: string; created_at: string }>(
        `INSERT INTO workflows (workspace_id, name, description, definition, created_by)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         RETURNING id, created_at`,
        [
          workspaceId,
          parsed.data.name,
          parsed.data.description ?? null,
          JSON.stringify(parsed.data.definition),
          (req as AuthenticatedRequest).uid ?? null,
        ],
      );
      res.status(201).json({ workflow: result.rows[0] });
    } catch (err) {
      console.error("[workflows] Create:", err);
      res.status(500).json({ error: "Failed to create workflow" });
    }
  });

  // GET /workflows — list workflows for workspace
  router.get("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.json({ workflows: [] });
      return;
    }

    try {
      const pool = getPool();
      const result = await pool.query(
        `SELECT id, workspace_id, name, description, status, created_by, created_at, updated_at
         FROM workflows
         WHERE workspace_id = $1
         ORDER BY created_at DESC
         LIMIT 100`,
        [workspaceId],
      );
      res.json({ workflows: result.rows });
    } catch (err) {
      console.error("[workflows] List:", err);
      res.status(500).json({ error: "Failed to list workflows" });
    }
  });

  // GET /workflows/:id — get a specific workflow
  router.get("/:id", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    try {
      const pool = getPool();
      const result = await pool.query(
        `SELECT id, workspace_id, name, description, definition, status, created_by, created_at, updated_at
         FROM workflows
         WHERE id = $1 AND workspace_id = $2`,
        [req.params.id, workspaceId],
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: "Workflow not found" });
        return;
      }
      res.json({ workflow: result.rows[0] });
    } catch (err) {
      console.error("[workflows] Get:", err);
      res.status(500).json({ error: "Failed to get workflow" });
    }
  });

  // DELETE /workflows/:id — delete a workflow
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
        `DELETE FROM workflows WHERE id = $1 AND workspace_id = $2 RETURNING id`,
        [req.params.id, workspaceId],
      );
      if (result.rowCount === 0) {
        res.status(404).json({ error: "Workflow not found" });
        return;
      }
      res.json({ deleted: true });
    } catch (err) {
      console.error("[workflows] Delete:", err);
      res.status(500).json({ error: "Failed to delete workflow" });
    }
  });

  // POST /workflows/:id/run — execute a workflow
  router.post("/:id/run", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsedBody = RunWorkflowBody.safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({ error: "Invalid request", details: parsedBody.error.format() });
      return;
    }

    try {
      const pool = getPool();
      // Fetch workflow
      const wfResult = await pool.query<{ definition: WorkflowDefinition }>(
        `SELECT definition FROM workflows WHERE id = $1 AND workspace_id = $2`,
        [req.params.id, workspaceId],
      );
      if (wfResult.rows.length === 0) {
        res.status(404).json({ error: "Workflow not found" });
        return;
      }

      const definition = wfResult.rows[0].definition;
      const uid = parsedBody.data.uid ?? (req as AuthenticatedRequest).uid ?? "system";
      const runId = randomUUID();

      // Insert run record
      await pool.query(
        `INSERT INTO workflow_runs (id, workflow_id, workspace_id, uid, status, input)
         VALUES ($1, $2, $3, $4, 'running', $5::jsonb)`,
        [runId, req.params.id, workspaceId, uid, JSON.stringify(parsedBody.data.input)],
      );

      const run = {
        id: runId,
        workflowId: req.params.id as string,
        workspaceId,
        uid,
        input: parsedBody.data.input,
      };

      const resolveClient = (config: Parameters<typeof getInferenceClientForAgent>[0]) =>
        getInferenceClientForAgent(config);

      // Execute workflow
      const output = await executeWorkflow(run, definition, resolveClient);

      // Update run record
      await pool.query(
        `UPDATE workflow_runs
         SET status = $1, output = $2::jsonb, error = $3, completed_at = NOW()
         WHERE id = $4`,
        [output.status, JSON.stringify(output.vars), output.error ?? null, runId],
      );

      res.status(200).json({ run: output });
    } catch (err) {
      console.error("[workflows] Run:", err);
      if (err instanceof Error && err.message.startsWith("Unknown agent:")) {
        res.status(404).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Failed to run workflow" });
    }
  });

  // GET /workflows/:id/runs — list runs for a workflow
  router.get("/:id/runs", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    try {
      const pool = getPool();
      const result = await pool.query(
        `SELECT id, workflow_id, workspace_id, uid, status, input, output, error, started_at, completed_at
         FROM workflow_runs
         WHERE workflow_id = $1 AND workspace_id = $2
         ORDER BY started_at DESC
         LIMIT 50`,
        [req.params.id, workspaceId],
      );
      res.json({ runs: result.rows });
    } catch (err) {
      console.error("[workflows] List runs:", err);
      res.status(500).json({ error: "Failed to list workflow runs" });
    }
  });

  return router;
}
