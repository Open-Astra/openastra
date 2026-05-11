// ── Route: Output Processor Chains ─────────────────────────────────────
import { Router } from "express";
import { z } from "zod";
import { getProcessors, addProcessor, removeProcessor } from "../../agents/output-processor.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";

const AddBody = z.object({
  agentId: z.string(),
  processorType: z.enum(["redact-pii", "reformat-json", "truncate", "translate", "uppercase", "lowercase"] as const),
  position: z.number().int().min(0).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export function createOutputProcessorsRouter(): Router {
  const router = Router();

  router.get("/:agentId", async (req, res) => {
    const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
    if (!workspaceId) return res.status(400).json({ error: "workspace required" });
    const processors = await getProcessors(req.params["agentId"]!, workspaceId);
    res.json(processors);
  });

  router.post("/", async (req, res) => {
    const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
    if (!workspaceId) return res.status(400).json({ error: "workspace required" });
    const parse = AddBody.safeParse(req.body);
    if (!parse.success) return res.status(400).json({ error: parse.error.flatten() });
    const { agentId, processorType, position, config } = parse.data;
    const p = await addProcessor(agentId, workspaceId, processorType, position ?? 0, config ?? {});
    res.status(201).json(p);
  });

  router.delete("/:id", async (req, res) => {
    const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
    if (!workspaceId) return res.status(400).json({ error: "workspace required" });
    const removed = await removeProcessor(req.params["id"]!, workspaceId);
    res.json({ removed });
  });

  return router;
}
