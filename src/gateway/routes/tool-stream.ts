import { Router } from "express";
import { getTool } from "../../tools/registry.js";
import { createStreamingContext } from "../../tools/streaming-result.js";
import type { ToolContext } from "../../tools/types.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { randomUUID } from "node:crypto";

export function createToolStreamRouter(): Router {
  const router = Router();

  // POST /tools/:toolName/stream — SSE endpoint for streaming tool execution
  router.post("/tools/:toolName/stream", async (req, res) => {
    const { toolName } = req.params as { toolName: string };
    const tool = getTool(toolName);
    if (!tool) {
      res.status(404).json({ error: `Tool not found: ${toolName}` });
      return;
    }

    // Validate params
    const parsed = tool.parameters.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues });
      return;
    }

    const uid = (req as unknown as AuthenticatedRequest).uid;
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const baseCtx: ToolContext = {
      uid,
      sessionId: randomUUID(),
      agentId: "api",
      workspaceId: workspaceId ?? undefined,
    };

    const ctx = createStreamingContext(baseCtx, (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    try {
      const result = await tool.execute(parsed.data, ctx);
      res.write(`data: ${JSON.stringify({ done: true, result })}\n\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.write(`data: ${JSON.stringify({ done: true, error: msg })}\n\n`);
    } finally {
      res.end();
    }
  });

  return router;
}
