// ── Internal Factory Helper ──────────────────────────────────────────
// Creates a raw (non-resilient) InferenceClient for a provider:model pair.
// Used by benchmarker and race mode where we need undecorated clients.

import type { InferenceClient } from "./types.js";
import { createGrokClient } from "./grok.js";
import { createGroqClient } from "./groq.js";
import { createOpenAIClient } from "./openai.js";
import { createGeminiClient } from "./gemini.js";
import { createClaudeClient } from "./claude.js";
import { createOllamaClient } from "./ollama.js";
import { createOpenRouterClient } from "./openrouter.js";

export function createPrimaryInferenceClient(
  provider: string,
  modelId: string,
  endpoint?: string,
): InferenceClient {
  switch (provider) {
    case "grok": {
      const apiKey = process.env.GROK_API_KEY;
      if (!apiKey) throw new Error("GROK_API_KEY required for grok provider");
      return createGrokClient(apiKey, endpoint ?? "https://api.x.ai/v1", modelId);
    }
    case "groq": {
      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) throw new Error("GROQ_API_KEY required for groq provider");
      return createGroqClient(apiKey, modelId);
    }
    case "openai": {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("OPENAI_API_KEY required for openai provider");
      return createOpenAIClient(apiKey, modelId);
    }
    case "gemini": {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("GEMINI_API_KEY required for gemini provider");
      return createGeminiClient(apiKey, modelId);
    }
    case "claude": {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY required for claude provider");
      return createClaudeClient(apiKey, modelId);
    }
    case "ollama": {
      const ep = endpoint ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
      return createOllamaClient(modelId, ep);
    }
    case "openrouter": {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) throw new Error("OPENROUTER_API_KEY required for openrouter provider");
      return createOpenRouterClient(apiKey, modelId);
    }
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}
