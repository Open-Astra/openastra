import { Router } from "express";
import { z } from "zod";
import { getRetryBudget, upsertRetryBudget, listDeadLetter, clearDeadLetter } from "../../agents/tool-retry.js";
import type { RetryBudget } from "../../agents/tool-retry.js";
import { WorkspaceAwareRequest } from "../../gateway/middleware/workspace.js";

const UpsertBudgetBody = z.object({
  toolName: z.string().min(1),
  maxAttempts: z.number().int().min(1).max(10),
  baseDelayMs: z.number().int().min(100).max(30000),
  maxDelayMs: z.number().int().min(1000).max(300000),
  jitter: z.boolean(),
});

export function createToolRetryRouter(): Router {
  const router = Router();

  router.get("/budgets", async (req, res) => {
    const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
    if (!workspaceId) return res.status(400).json({ error: "workspace required" });

    const limit = req.query["limit"] !== undefined ? Number(req.query["limit"]) : undefined;
    const items = await listDeadLetter(workspaceId, limit);
    res.json(items);
  });

  router.get("/budgets/:toolName", async (req, res) => {
    const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
    if (!workspaceId) return res.status(400).json({ error: "workspace required" });

    const budget: RetryBudget | null = await getRetryBudget(req.params["toolName"]!, workspaceId);
    if (!budget) return res.status(404).json({ error: "not found" });
    res.json(budget);
  });

  router.put("/budgets", async (req, res) => {
    const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
    if (!workspaceId) return res.status(400).json({ error: "workspace required" });

    const parsed = UpsertBudgetBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { toolName, maxAttempts, baseDelayMs, maxDelayMs, jitter } = parsed.data;
    await upsertRetryBudget({ toolName, workspaceId, maxAttempts, baseDelayMs, maxDelayMs, jitter });
    res.json({ ok: true });
  });

  router.delete("/dead-letter/:id", async (req, res) => {
    const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
    if (!workspaceId) return res.status(400).json({ error: "workspace required" });

    const deleted = await clearDeadLetter(req.params["id"]!, workspaceId);
    res.json({ deleted });
  });

  return router;
}
