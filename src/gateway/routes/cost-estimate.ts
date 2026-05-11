import { Router } from "express";
import { z } from "zod";
import type { ChatMessage } from "../../inference/types.js";
import { preflightEstimate } from "../../agents/cost-estimator.js";

const CostEstimateBody = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  messages: z.array(z.object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.string().nullable(),
  })).default([]),
  systemPrompt: z.string().optional(),
  estimatedOutputTokens: z.number().int().positive().optional(),
});

export function createCostEstimateRouter(): Router {
  const router = Router();

  // POST /cost-estimate — pre-flight cost estimate before inference
  router.post("/cost-estimate", (req, res) => {
    const body = CostEstimateBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.issues });
      return;
    }
    const { provider, model, messages, systemPrompt, estimatedOutputTokens } = body.data;
    const estimate = preflightEstimate(provider, model, messages as ChatMessage[], {
      systemPrompt,
      estimatedOutputTokens,
    });
    res.json(estimate);
  });

  return router;
}
