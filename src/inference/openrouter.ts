// ── OpenRouter Provider ──────────────────────────────────────────────
// OpenRouter exposes an OpenAI-compatible API at openrouter.ai.
// Supports routing to 200+ models from OpenAI, Anthropic, Meta, etc.
// Set OPENROUTER_API_KEY and use model IDs like "openai/gpt-4o" or
// "anthropic/claude-3.5-sonnet".
//
// Caching: set `cache: true` on InferenceRequest to enable OpenRouter's
// response caching by sending the X-OpenRouter-Cache: true header.

import type { InferenceClient, InferenceRequest, InferenceResponse, InferenceStreamDelta } from "./types.js";
import { createOpenAIClient } from "./openai.js";

export function createOpenRouterClient(apiKey: string, modelId: string): InferenceClient {
  // Base client uses static default headers (no cache header by default).
  const baseClient = createOpenAIClient(
    apiKey,
    modelId,
    "https://openrouter.ai/api/v1",
    {
      "HTTP-Referer": "https://astra.ai",
      "X-Title": "Astra",
    },
  );

  // Cached client includes X-OpenRouter-Cache header for cache-eligible requests.
  const cachedClient = createOpenAIClient(
    apiKey,
    modelId,
    "https://openrouter.ai/api/v1",
    {
      "HTTP-Referer": "https://astra.ai",
      "X-Title": "Astra",
      "X-OpenRouter-Cache": "true",
    },
  );

  return {
    async chat(request: InferenceRequest): Promise<InferenceResponse> {
      const client = request.cache ? cachedClient : baseClient;
      return client.chat(request);
    },

    async *chatStream(request: InferenceRequest): AsyncIterable<InferenceStreamDelta> {
      const client = request.cache ? cachedClient : baseClient;
      yield* client.chatStream(request);
    },
  };
}
