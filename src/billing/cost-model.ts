// ── Cost Model ──────────────────────────────────────────────────────
// Per-model pricing table and cost estimation utilities.
// Prices are in USD per 1 million tokens.

// ── Types ───────────────────────────────────────────────────────────

export interface ModelPricing {
  promptCostPer1M: number;
  completionCostPer1M: number;
}

// ── Pricing Table ───────────────────────────────────────────────────

const MODEL_PRICING: Record<string, ModelPricing> = {
  // Claude
  "claude-opus-4-6": { promptCostPer1M: 15, completionCostPer1M: 75 },
  "claude-sonnet-4-6": { promptCostPer1M: 3, completionCostPer1M: 15 },
  "claude-haiku-4-5-20251001": { promptCostPer1M: 0.80, completionCostPer1M: 4 },

  // OpenAI
  "gpt-4o": { promptCostPer1M: 2.5, completionCostPer1M: 10 },
  "gpt-4o-mini": { promptCostPer1M: 0.15, completionCostPer1M: 0.6 },
  "o3": { promptCostPer1M: 10, completionCostPer1M: 40 },

  // Groq
  "llama-3.3-70b-versatile": { promptCostPer1M: 0.59, completionCostPer1M: 0.79 },
  "llama-3.1-8b-instant": { promptCostPer1M: 0.05, completionCostPer1M: 0.08 },

  // Grok
  "grok-4.1-fast": { promptCostPer1M: 3, completionCostPer1M: 15 },

  // Gemini
  "gemini-2.5-pro": { promptCostPer1M: 1.25, completionCostPer1M: 10 },
  "gemini-2.5-flash": { promptCostPer1M: 0.15, completionCostPer1M: 0.6 },
};

// Default pricing for unknown models — conservative mid-range estimate
const DEFAULT_PRICING: ModelPricing = { promptCostPer1M: 2, completionCostPer1M: 8 };

// ── Public API ──────────────────────────────────────────────────────

/**
 * Estimate cost in cents for a given token usage and model.
 * Looks up modelId in the pricing table; falls back to default pricing
 * for unknown models.
 */
export function estimateCost(
  usage: { promptTokens: number; completionTokens: number },
  modelId: string,
): number {
  const pricing = MODEL_PRICING[modelId] ?? DEFAULT_PRICING;
  const promptCost = (usage.promptTokens / 1_000_000) * pricing.promptCostPer1M * 100;
  const completionCost = (usage.completionTokens / 1_000_000) * pricing.completionCostPer1M * 100;
  return promptCost + completionCost;
}

/**
 * Get pricing for a specific model. Returns null if model is not
 * in the known pricing table.
 */
export function getModelPricing(modelId: string): ModelPricing | null {
  return MODEL_PRICING[modelId] ?? null;
}

/**
 * List all model IDs that have known pricing.
 */
export function listSupportedModels(): string[] {
  return Object.keys(MODEL_PRICING);
}
