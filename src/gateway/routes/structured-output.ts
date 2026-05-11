// ── Route: Structured Output Schemas ───────────────────────────────────
import { Router } from "express";
import { z } from "zod";
import { getOutputSchema, upsertOutputSchema } from "../../agents/structured-output.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";

const UpsertBody = z.object({
  agentId: z.string(),
  name: z.string(),
  schema: z.record(z.string(), z.unknown()),
  maxRepairAttempts: z.number().int().min(0).max(5).optional(),
  description: z.string().optional(),
});

export function createStructuredOutputRouter(): Router {
  const router = Router();

  router.get("/:agentId", async (req, res) => {
    const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
    if (!workspaceId) return res.status(400).json({ error: "workspace required" });
    const schema = await getOutputSchema(req.params["agentId"]!, workspaceId);
    if (!schema) return res.status(404).json({ error: "not found" });
    res.json(schema);
  });

  router.put("/", async (req, res) => {
    const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
    if (!workspaceId) return res.status(400).json({ error: "workspace required" });
    const parse = UpsertBody.safeParse(req.body);
    if (!parse.success) return res.status(400).json({ error: parse.error.flatten() });
    const { agentId, name, schema, maxRepairAttempts, description } = parse.data;
    await upsertOutputSchema(agentId, workspaceId, name, schema, maxRepairAttempts, description);
    res.json({ ok: true });
  });

  return router;
}
