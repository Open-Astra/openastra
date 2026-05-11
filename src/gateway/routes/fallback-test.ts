import { Router } from "express";
import { z } from "zod";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("fallback-test");

const FallbackTestBody = z.object({
  agentId: z.string().min(1),
  prompt: z.string().min(1).max(1000),
});

export function createFallbackTestRouter(): Router {
  const router = Router();

  // POST /inference/fallback-test — test fallback chain for an agent
  router.post("/inference/fallback-test", async (req, res) => {
    const body = FallbackTestBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: body.error.issues }); return; }

    try {
      const { getAgentConfig } = await import("../../config/agents.js");
      const { getInferenceClientForAgent } = await import("../../inference/factory.js");
      const agentConfig = getAgentConfig(body.data.agentId);
      const client = getInferenceClientForAgent(agentConfig);

      const start = Date.now();
      const response = await client.chat({
        messages: [{ role: "user", content: body.data.prompt }],
        maxTokens: 64,
      });

      res.json({
        success: true,
        response: response.content,
        latencyMs: Date.now() - start,
        provider: agentConfig.model.provider,
        model: agentConfig.model.modelId,
        fallbackChain: (agentConfig as Record<string, unknown>)["fallbackChain"] ?? [],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Unknown agent")) {
        res.status(404).json({ error: msg }); return;
      }
      logger.warn(`Fallback test failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
