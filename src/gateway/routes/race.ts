import { Router } from "express";
import { z } from "zod";
import { raceInference } from "../../inference/race.js";
import { createPrimaryInferenceClient } from "../../inference/factory-internal.js";

const RaceBody = z.object({
  providers: z.array(z.object({
    provider: z.string(),
    modelId: z.string(),
    endpoint: z.string().url().optional(),
  })).min(2).max(5),
  message: z.string().min(1),
  systemPrompt: z.string().optional(),
  timeoutMs: z.number().int().positive().max(60_000).default(30_000),
});

export function createRaceRouter(): Router {
  const router = Router();

  // POST /inference/race — race multiple providers, return first response
  router.post("/inference/race", async (req, res) => {
    const body = RaceBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: body.error.issues }); return; }

    const clients = [];
    for (const { provider, modelId, endpoint } of body.data.providers) {
      try {
        clients.push({
          client: createPrimaryInferenceClient(provider, modelId, endpoint),
          label: `${provider}:${modelId}`,
        });
      } catch (err) {
        res.status(400).json({ error: `Cannot create client for ${provider}:${modelId} — ${err instanceof Error ? err.message : err}` });
        return;
      }
    }

    const messages = [
      ...(body.data.systemPrompt ? [{ role: "system" as const, content: body.data.systemPrompt }] : []),
      { role: "user" as const, content: body.data.message },
    ];

    try {
      const result = await raceInference({ messages }, { clients, timeoutMs: body.data.timeoutMs });
      res.json({
        response: result.response.content,
        winner: result.winner,
        loserMs: result.loserMs,
        usage: result.response.usage,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
