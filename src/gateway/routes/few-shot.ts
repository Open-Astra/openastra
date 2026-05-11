// ── Route: Few-Shot Example Library ────────────────────────────────────
import { Router } from "express";
import { z } from "zod";
import { addExample, getExamples, deleteExample } from "../../agents/few-shot.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";

const AddBody = z.object({
  agentId: z.string(),
  taskType: z.string(),
  userInput: z.string(),
  expectedOutput: z.string(),
  score: z.number().min(0).max(1).optional(),
});

export function createFewShotRouter(): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
    if (!workspaceId) return res.status(400).json({ error: "workspace required" });
    const agentId = typeof req.query["agentId"] === "string" ? req.query["agentId"] : "";
    const taskType = typeof req.query["taskType"] === "string" ? req.query["taskType"] : undefined;
    const limit = req.query["limit"] ? parseInt(String(req.query["limit"]), 10) : 10;
    const examples = await getExamples(agentId, workspaceId, taskType, limit);
    res.json(examples);
  });

  router.post("/", async (req, res) => {
    const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
    if (!workspaceId) return res.status(400).json({ error: "workspace required" });
    const parse = AddBody.safeParse(req.body);
    if (!parse.success) return res.status(400).json({ error: parse.error.flatten() });
    const { agentId, taskType, userInput, expectedOutput, score } = parse.data;
    const example = await addExample(agentId, workspaceId, taskType, userInput, expectedOutput, score ?? 1.0);
    res.status(201).json(example);
  });

  router.delete("/:id", async (req, res) => {
    const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
    if (!workspaceId) return res.status(400).json({ error: "workspace required" });
    const deleted = await deleteExample(req.params["id"]!, workspaceId);
    res.json({ deleted });
  });

  return router;
}
