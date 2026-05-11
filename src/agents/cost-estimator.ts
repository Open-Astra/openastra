// ── Inference Pre-flight Cost Estimator ─────────────────────────────
// Estimates token count and cost before executing inference.

import type { ChatMessage } from "../inference/types.js";

// Pricing table: [inputCostPer1M, outputCostPer1M] in USD
const PRICING: Record<string, [number, number]> = {
  "openai:gpt-4o":                  [2.50, 10.00],
  "openai:gpt-4o-mini":             [0.15,  0.60],
  "openai:gpt-4-turbo":             [10.00, 30.00],
  "openai:gpt-3.5-turbo":           [0.50,  1.50],
  "claude:claude-3-5-sonnet-20241022": [3.00, 15.00],
  "claude:claude-3-5-haiku-20241022":  [0.80,  4.00],
  "claude:claude-3-opus-20240229":   [15.00, 75.00],
  "claude:claude-sonnet-4-6":        [3.00, 15.00],
  "gemini:gemini-1.5-pro":          [1.25,  5.00],
  "gemini:gemini-1.5-flash":        [0.075, 0.30],
  "gemini:gemini-2.0-flash":        [0.10,  0.40],
  "grok:grok-2":                    [2.00, 10.00],
  "grok:grok-beta":                 [5.00, 15.00],
  "groq:llama-3.3-70b-versatile":   [0.59,  0.79],
  "groq:mixtral-8x7b-32768":        [0.24,  0.24],
  "ollama:*":                        [0.00,  0.00],
  "vllm:*":                          [0.00,  0.00],
};

/** Rough token estimate: ~4 characters per token (English average). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Estimate tokens across a full message array + system prompt. */
export function estimateMessagesTokens(
  messages: ChatMessage[],
  systemPrompt?: string,
): number {
  let total = 0;
  if (systemPrompt) total += estimateTokens(systemPrompt);
  for (const msg of messages) {
    if (typeof msg.content === "string") total += estimateTokens(msg.content);
    // Add overhead per message for role + formatting
    total += 4;
  }
  return total;
}

export interface CostEstimate {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  inputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
  currency: "USD";
  warning?: string;
}

/**
 * Estimate cost for a given provider + model + token counts.
 * Falls back to zeroed estimate for unknown models.
 */
export function estimateCost(
  provider: string,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): CostEstimate {
  const exactKey = `${provider}:${modelId}`;
  const wildcardKey = `${provider}:*`;

  const pricing = PRICING[exactKey] ?? PRICING[wildcardKey];

  if (!pricing) {
    return {
      provider,
      model: modelId,
      inputTokens,
      outputTokens,
      inputCostUsd: 0,
      outputCostUsd: 0,
      totalCostUsd: 0,
      currency: "USD",
      warning: `No pricing data for ${exactKey} — estimate unavailable`,
    };
  }

  const [inputRate, outputRate] = pricing;
  const inputCostUsd = (inputTokens / 1_000_000) * inputRate!;
  const outputCostUsd = (outputTokens / 1_000_000) * outputRate!;

  return {
    provider,
    model: modelId,
    inputTokens,
    outputTokens,
    inputCostUsd: Math.round(inputCostUsd * 1_000_000) / 1_000_000,
    outputCostUsd: Math.round(outputCostUsd * 1_000_000) / 1_000_000,
    totalCostUsd: Math.round((inputCostUsd + outputCostUsd) * 1_000_000) / 1_000_000,
    currency: "USD",
  };
}

/**
 * Full pre-flight: estimate tokens from messages, then compute cost.
 */
export function preflightEstimate(
  provider: string,
  modelId: string,
  messages: ChatMessage[],
  options: { systemPrompt?: string; estimatedOutputTokens?: number } = {},
): CostEstimate {
  const inputTokens = estimateMessagesTokens(messages, options.systemPrompt);
  const outputTokens = options.estimatedOutputTokens ?? Math.ceil(inputTokens * 0.5);
  return estimateCost(provider, modelId, inputTokens, outputTokens);
}
