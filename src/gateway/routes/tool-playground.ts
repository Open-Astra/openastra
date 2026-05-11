import { Router } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { getTool, getRegisteredToolNames } from "../../tools/registry.js";
import type { ToolContext } from "../../tools/types.js";
import { randomUUID } from "node:crypto";

export function createToolPlaygroundRouter(): Router {
  const router = Router();

  // GET /playground/tools — list all registered tools
  router.get("/playground/tools", (_req, res) => {
    res.json({ tools: getRegisteredToolNames() });
  });

  // POST /playground/tool/:toolName — invoke a tool directly without agent
  router.post("/playground/tool/:toolName", async (req, res) => {
    const { toolName } = req.params as { toolName: string };
    const tool = getTool(toolName);
    if (!tool) {
      res.status(404).json({ error: `Tool not found: ${toolName}` });
      return;
    }

    const parsed = tool.parameters.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues });
      return;
    }

    const uid = (req as unknown as AuthenticatedRequest).uid;
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;

    const ctx: ToolContext = {
      uid,
      sessionId: randomUUID(),
      agentId: "playground",
      workspaceId: workspaceId ?? undefined,
    };

    const start = Date.now();
    try {
      const result = await tool.execute(parsed.data, ctx);
      res.json({
        toolName,
        result,
        durationMs: Date.now() - start,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg, durationMs: Date.now() - start });
    }
  });

  return router;
}
