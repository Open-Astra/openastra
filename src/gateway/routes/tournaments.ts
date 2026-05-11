import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { getPool } from "../../config/postgres.js";
import { getInferenceClientForAgent } from "../../inference/factory.js";
import { runTournament } from "../../agents/tournament.js";

// ── Zod Schemas ──────────────────────────────────────────────────────

const CreateTournamentBody = z.object({
  name: z.string().min(1).max(256),
  agentIds: z.array(z.string().min(1)).min(2).max(20),
  testPrompts: z.array(z.string().min(1).max(10_000)).min(1).max(50),
  metric: z.string().max(64).default("response_quality"),
});

// ── Router ───────────────────────────────────────────────────────────

export function createTournamentsRouter(): Router {
  const router = Router();

  // POST /tournaments — create a tournament
  router.post("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = CreateTournamentBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    try {
      const pool = getPool();
      const result = await pool.query<{ id: string; created_at: string }>(
        `INSERT INTO agent_tournaments (workspace_id, name, agent_ids, test_prompts, metric)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, created_at`,
        [
          workspaceId,
          parsed.data.name,
          parsed.data.agentIds,
          parsed.data.testPrompts,
          parsed.data.metric,
        ],
      );
      res.status(201).json({ tournament: result.rows[0] });
    } catch (err) {
      console.error("[tournaments] Create:", err);
      res.status(500).json({ error: "Failed to create tournament" });
    }
  });

  // GET /tournaments/:id — get tournament status and results
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
        `SELECT id, workspace_id, name, agent_ids, test_prompts, metric, status,
                results, winner_agent_id, created_at, completed_at
         FROM agent_tournaments
         WHERE id = $1 AND workspace_id = $2`,
        [req.params.id, workspaceId],
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: "Tournament not found" });
        return;
      }
      res.json({ tournament: result.rows[0] });
    } catch (err) {
      console.error("[tournaments] Get:", err);
      res.status(500).json({ error: "Failed to get tournament" });
    }
  });

  // GET /tournaments — list tournaments for workspace
  router.get("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.json({ tournaments: [] });
      return;
    }

    try {
      const pool = getPool();
      const result = await pool.query(
        `SELECT id, workspace_id, name, agent_ids, metric, status, winner_agent_id, created_at, completed_at
         FROM agent_tournaments
         WHERE workspace_id = $1
         ORDER BY created_at DESC
         LIMIT 100`,
        [workspaceId],
      );
      res.json({ tournaments: result.rows });
    } catch (err) {
      console.error("[tournaments] List:", err);
      res.status(500).json({ error: "Failed to list tournaments" });
    }
  });

  // POST /tournaments/:id/run — execute a tournament
  router.post("/:id/run", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    try {
      const pool = getPool();
      const tResult = await pool.query<{
        agent_ids: string[];
        test_prompts: string[];
        status: string;
      }>(
        `SELECT agent_ids, test_prompts, status FROM agent_tournaments WHERE id = $1 AND workspace_id = $2`,
        [req.params.id, workspaceId],
      );

      if (tResult.rows.length === 0) {
        res.status(404).json({ error: "Tournament not found" });
        return;
      }

      const { agent_ids, test_prompts, status } = tResult.rows[0];

      if (status === "running") {
        res.status(409).json({ error: "Tournament already running" });
        return;
      }

      // Mark as running
      await pool.query(
        `UPDATE agent_tournaments SET status = 'running' WHERE id = $1`,
        [req.params.id],
      );

      const resolveClient = (config: Parameters<typeof getInferenceClientForAgent>[0]) =>
        getInferenceClientForAgent(config);

      const tournamentResult = await runTournament(
        req.params.id as string,
        agent_ids,
        test_prompts,
        resolveClient,
      );

      res.status(200).json({ result: tournamentResult });
    } catch (err) {
      console.error("[tournaments] Run:", err);
      if (err instanceof Error && err.message.startsWith("Unknown agent:")) {
        res.status(404).json({ error: err.message });
        return;
      }
      // Reset status on error
      try {
        const pool = getPool();
        await pool.query(
          `UPDATE agent_tournaments SET status = 'failed' WHERE id = $1`,
          [req.params.id],
        );
      } catch { /* best-effort */ }
      res.status(500).json({ error: "Failed to run tournament" });
    }
  });

  return router;
}
