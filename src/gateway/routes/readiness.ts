import { Router } from "express";
import { z } from "zod";
import { warmUpAll, warmUpProvider, computeReadinessStatus } from "../../inference/warm-pool-probe.js";
function getConfiguredProviders(): Array<{ provider: string; modelId: string; endpoint?: string }> {
  const providers: Array<{ provider: string; modelId: string; endpoint?: string }> = [];

  if (process.env.OPENAI_API_KEY) providers.push({ provider: "openai", modelId: "gpt-4o-mini" });
  if (process.env.ANTHROPIC_API_KEY) providers.push({ provider: "claude", modelId: "claude-haiku-4-5-20251001" });
  if (process.env.GEMINI_API_KEY) providers.push({ provider: "gemini", modelId: "gemini-1.5-flash" });
  if (process.env.GROK_API_KEY) providers.push({ provider: "grok", modelId: "grok-2" });
  if (process.env.GROQ_API_KEY) providers.push({ provider: "groq", modelId: "llama-3.3-70b-versatile" });
  if (process.env.OLLAMA_BASE_URL) providers.push({ provider: "ollama", modelId: "llama3.2" });

  return providers;
}

const WarmUpBody = z.object({
  providers: z.array(z.object({
    provider: z.string(),
    modelId: z.string(),
    endpoint: z.string().url().optional(),
  })).optional(),
});

export function createReadinessRouter(): Router {
  const router = Router();

  // GET /readiness — probe all configured providers
  router.get("/readiness", async (_req, res) => {
    const providers = getConfiguredProviders();
    const results = await warmUpAll({ providers });
    const status = computeReadinessStatus(results);
    res.status(status === "unavailable" ? 503 : 200).json({
      status,
      providers: results,
      checkedAt: new Date().toISOString(),
    });
  });

  // POST /readiness/warm-up — manually warm up specific providers
  router.post("/readiness/warm-up", async (req, res) => {
    const body = WarmUpBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: body.error.issues }); return; }

    const providers = body.data.providers ?? getConfiguredProviders();
    const results = await Promise.all(
      providers.map(({ provider, modelId, endpoint }) => warmUpProvider(provider, modelId, endpoint)),
    );
    const status = computeReadinessStatus(results);
    res.json({ status, providers: results });
  });

  return router;
}
