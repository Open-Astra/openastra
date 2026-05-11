import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import {
  getBudget,
  createBudget,
  getTransactions,
  checkBudget,
} from "../../agents/budget-pool.js";
import { getPool } from "../../config/postgres.js";

// ── Budget Router ────────────────────────────────────────────────────

const CreateBudgetBody = z.object({
  totalBudgetUsd: z.number().positive(),
  perAgentCapUsd: z.number().positive().optional(),
  periodEnd: z.string().optional(),
});

export function createBudgetRouter(): Router {
  const router = Router();

  // GET /budget — get workspace budget
  router.get("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const budget = await getBudget(workspaceId);
    if (!budget) {
      res.status(404).json({ error: "No budget configured" });
      return;
    }
    res.json(budget);
  });

  // POST /budget — create/update budget
  router.post("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = CreateBudgetBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const { totalBudgetUsd, perAgentCapUsd, periodEnd } = parsed.data;
    const budget = await createBudget(
      workspaceId,
      totalBudgetUsd,
      perAgentCapUsd,
      periodEnd ? new Date(periodEnd) : undefined,
    );
    res.status(201).json(budget);
  });

  // GET /budget/transactions — list transactions
  router.get("/transactions", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const agentId = req.query.agentId as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

    const txns = await getTransactions(workspaceId, { agentId, limit });
    res.json(txns);
  });

  // GET /budget/check — check if within budget
  router.get("/check", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const agentId = req.query.agentId as string | undefined;
    const result = await checkBudget(workspaceId, agentId);
    res.json(result);
  });

  // GET /budget/agents — per-agent spend breakdown
  router.get("/agents", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT agent_id, SUM(amount_usd)::float AS total_spent, COUNT(*)::int AS tx_count
       FROM budget_transactions
       WHERE workspace_id = $1
       GROUP BY agent_id
       ORDER BY total_spent DESC`,
      [workspaceId],
    );

    const budget = await getBudget(workspaceId);
    const perAgentCap = budget?.perAgentCapUsd;

    const agents = rows.map((r) => ({
      agentId: r.agent_id,
      totalSpent: parseFloat(r.total_spent),
      transactionCount: r.tx_count,
      remaining: perAgentCap !== undefined ? perAgentCap - parseFloat(r.total_spent) : undefined,
    }));

    res.json({ agents, perAgentCap });
  });

  return router;
}
