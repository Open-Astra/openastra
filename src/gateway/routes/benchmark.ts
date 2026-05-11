import { Router } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { runBenchmark } from "../../inference/benchmarker.js";
import { getPool } from "../../config/postgres.js";
import { randomUUID } from "node:crypto";

const BenchmarkBody = z.object({
  prompt: z.string().min(1),
  systemPrompt: z.string().optional(),
  providers: z.array(z.object({
    provider: z.string(),
    modelId: z.string(),
  })).min(1).max(10),
  warmupRuns: z.number().int().min(0).max(3).default(1),
  timedRuns: z.number().int().min(1).max(10).default(3),
});

export function createBenchmarkRouter(): Router {
  const router = Router();
  const pool = () => getPool();

  router.post("/inference/benchmark", async (req, res) => {
    const body = BenchmarkBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: body.error.issues }); return; }

    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    const uid = (req as unknown as AuthenticatedRequest).uid;

    const results = await runBenchmark(body.data);

    // Persist benchmark run
    await pool().query(
      `INSERT INTO inference_benchmarks (id, workspace_id, run_by, config, results)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
      [randomUUID(), workspaceId, uid, JSON.stringify(body.data), JSON.stringify(results)],
    ).catch(() => {});

    res.json({ results, ranAt: new Date().toISOString() });
  });

  router.get("/inference/benchmark/history", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    const limit = Math.min(parseInt(String(req.query["limit"] ?? "10"), 10), 50);
    const { rows } = await pool().query(
      `SELECT id, run_by AS "runBy", config, results, ran_at AS "ranAt"
       FROM inference_benchmarks WHERE workspace_id = $1 ORDER BY ran_at DESC LIMIT $2`,
      [workspaceId, limit],
    );
    res.json({ benchmarks: rows });
  });

  return router;
}
