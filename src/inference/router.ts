import type { InferenceClient, InferenceRequest, InferenceResponse } from "./types.js";
import { createLogger } from "../utils/logger.js";

// ── Model Router ───────────────────────────────────────────────────
// Dynamic model selection based on task complexity, context length,
// and cost optimization. Routes requests to the most appropriate
// model rather than always using a single fixed model.
//
// Routing strategy:
//   1. Estimate task complexity from message content
//   2. Check context length requirements
//   3. Select cheapest model that meets quality threshold
//   4. Fall back to primary model if routing fails

const log = createLogger("model-router");

export interface ModelTier {
  name: string;
  client: InferenceClient;
  maxContext: number;
  costPer1kTokens: number; // relative cost (1 = cheapest)
  capabilities: Set<string>; // "tool_calling", "code", "reasoning", "long_context"
  minComplexity: number; // 0-1 threshold
}

export interface RouterConfig {
  tiers: ModelTier[];
  defaultTier: string;
  enableCostOptimization: boolean;
}

// Complexity signals in user messages
const HIGH_COMPLEXITY_SIGNALS = [
  "analyze", "compare", "evaluate", "explain why", "investigate",
  "debug", "architect", "design", "optimize", "refactor",
  "multi-step", "complex", "comprehensive", "in-depth",
];

const LOW_COMPLEXITY_SIGNALS = [
  "what is", "define", "list", "simple", "quick",
  "yes or no", "true or false", "format", "convert",
];

export function estimateComplexity(messages: InferenceRequest["messages"]): number {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser?.content) return 0.5;

  const text = (typeof lastUser.content === "string" ? lastUser.content : "").toLowerCase();
  const wordCount = text.split(/\s+/).length;

  let score = 0.5;

  // Length-based: longer prompts tend to be more complex
  if (wordCount > 200) score += 0.15;
  else if (wordCount > 100) score += 0.1;
  else if (wordCount < 20) score -= 0.1;

  // Signal-based
  for (const signal of HIGH_COMPLEXITY_SIGNALS) {
    if (text.includes(signal)) { score += 0.1; break; }
  }
  for (const signal of LOW_COMPLEXITY_SIGNALS) {
    if (text.includes(signal)) { score -= 0.1; break; }
  }

  // Tool use: if tools are involved, prefer capable models
  const hasToolCalls = messages.some((m) => m.role === "tool" || m.tool_calls?.length);
  if (hasToolCalls) score += 0.15;

  // Context length: more messages = higher complexity
  if (messages.length > 20) score += 0.1;
  if (messages.length > 40) score += 0.1;

  return Math.max(0, Math.min(1, score));
}

export function estimateTokenCount(messages: InferenceRequest["messages"]): number {
  // Rough estimate: 1 token ≈ 4 chars, ~85 tokens per image
  return messages.reduce((sum, m) => {
    if (typeof m.content === "string") return sum + m.content.length / 4;
    if (Array.isArray(m.content)) {
      return sum + m.content.reduce((s, p) => {
        if (p.type === "text") return s + p.text.length / 4;
        if (p.type === "image_url") return s + 85;
        return s;
      }, 0);
    }
    return sum;
  }, 0);
}

export function selectTier(
  config: RouterConfig,
  request: InferenceRequest,
): ModelTier {
  const complexity = estimateComplexity(request.messages);
  const tokenEstimate = estimateTokenCount(request.messages);
  const needsTools = (request.tools?.length ?? 0) > 0;

  // Filter tiers by requirements
  const eligible = config.tiers.filter((tier) => {
    // Must fit context
    if (tokenEstimate > tier.maxContext * 0.8) return false;
    // Must support tools if needed
    if (needsTools && !tier.capabilities.has("tool_calling")) return false;
    // Must meet minimum complexity threshold
    if (complexity < tier.minComplexity) return false;
    return true;
  });

  if (eligible.length === 0) {
    // Fallback to default
    return config.tiers.find((t) => t.name === config.defaultTier) ?? config.tiers[0]!;
  }

  if (config.enableCostOptimization) {
    // Pick the cheapest eligible tier that meets the complexity bar
    eligible.sort((a, b) => a.costPer1kTokens - b.costPer1kTokens);
  } else {
    // Pick the most capable eligible tier
    eligible.sort((a, b) => b.maxContext - a.maxContext);
  }

  const selected = eligible[0]!;
  log.dim(`Routed to ${selected.name} (complexity: ${complexity.toFixed(2)}, tokens: ~${tokenEstimate})`);
  return selected;
}

/**
 * Create a routing inference client that dynamically selects the best
 * model tier for each request.
 */
export function createRoutingClient(config: RouterConfig): InferenceClient {
  return {
    async chat(request: InferenceRequest): Promise<InferenceResponse> {
      const tier = selectTier(config, request);
      return tier.client.chat(request);
    },

    async *chatStream(request: InferenceRequest) {
      const tier = selectTier(config, request);
      yield* tier.client.chatStream(request);
    },
  };
}
