import type { InferenceClient } from "./types.js";
import type { AgentConfig } from "../agents/types.js";
import { createGrokClient } from "./grok.js";
import { createGroqClient } from "./groq.js";
import { createOpenAIClient } from "./openai.js";
import { createGeminiClient } from "./gemini.js";
import { createClaudeClient } from "./claude.js";
import { createOllamaClient } from "./ollama.js";
import { createOpenRouterClient } from "./openrouter.js";
import { createMistralClient } from "./mistral.js";
import { createBedrockClient } from "./bedrock.js";
import { createEdgeClient } from "./edge.js";
import { createResilientClient } from "./resilient.js";
import { warmPool } from "./warm-pool.js";
import { withSemanticCache } from "./semantic-cache-layer.js";
import { predictTokenUsage } from "./token-budget-predictor.js";

// ── Provider Auth Aliases ──────────────────────────────────────────
// Maps provider variant names to the canonical env-var provider key
// when a provider-specific key is missing. The alias is used as a
// fallback only — the provider-specific key always takes precedence.
const AUTH_ALIAS_MAP: Record<string, string> = {
  "openai-completions": "openai",
  "openai-codex": "openai",
  "openrouter": "openai", // fallback only if OPENROUTER_API_KEY is missing
};

/**
 * Resolve an API key for a provider, falling back to an alias key if the
 * primary env var is absent. Logs a debug message when the alias is used.
 */
function resolveApiKey(
  provider: string,
  primaryEnvVar: string,
  aliasProvider?: string,
): string | undefined {
  const primary = process.env[primaryEnvVar];
  if (primary) return primary;

  const alias = aliasProvider ?? AUTH_ALIAS_MAP[provider];
  if (!alias) return undefined;

  const aliasEnvVars: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    grok: "GROK_API_KEY",
    groq: "GROQ_API_KEY",
    gemini: "GEMINI_API_KEY",
    claude: "ANTHROPIC_API_KEY",
  };

  const aliasEnvVar = aliasEnvVars[alias];
  if (!aliasEnvVar) return undefined;

  const aliasKey = process.env[aliasEnvVar];
  if (aliasKey) {
    console.debug(
      `[factory] ${primaryEnvVar} not set — using ${aliasEnvVar} alias for "${provider}" provider`,
    );
  }
  return aliasKey;
}

// ── Inference Client Factory ───────────────────────────────────────
// Creates the appropriate inference client based on agent model config.
// Wraps every client in the resilient layer (retry + failover).
// Caches clients keyed by provider:modelId:endpoint to avoid duplicates.

let _fallbackClient: InferenceClient | null = null;

function getFallbackClient(): InferenceClient | undefined {
  if (_fallbackClient) return _fallbackClient;

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) return undefined;

  _fallbackClient = createOpenAIClient(openaiKey, "gpt-4o-mini");
  return _fallbackClient;
}

function createPrimaryClient(modelConfig: AgentConfig["model"]): InferenceClient {
  switch (modelConfig.provider) {
    case "grok": {
      const apiKey = process.env.GROK_API_KEY;
      if (!apiKey) throw new Error("GROK_API_KEY required for grok provider");
      return createGrokClient(apiKey, modelConfig.endpoint ?? "https://api.x.ai/v1", modelConfig.modelId);
    }
    case "groq": {
      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) throw new Error("GROQ_API_KEY required for groq provider");
      return createGroqClient(apiKey, modelConfig.modelId);
    }
    case "openai": {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("OPENAI_API_KEY required for openai provider");
      return createOpenAIClient(apiKey, modelConfig.modelId);
    }
    case "gemini": {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("GEMINI_API_KEY required for gemini provider");
      return createGeminiClient(apiKey, modelConfig.modelId);
    }
    case "claude": {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY required for claude provider");
      return createClaudeClient(apiKey, modelConfig.modelId);
    }
    case "vllm": {
      const apiKey = process.env.VLLM_API_KEY || "no-key";
      if (!modelConfig.endpoint) throw new Error("endpoint required for vllm provider");
      return createGrokClient(apiKey, modelConfig.endpoint, modelConfig.modelId);
    }
    case "ollama": {
      const endpoint = modelConfig.endpoint ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
      return createOllamaClient(modelConfig.modelId, endpoint, modelConfig.maxContextTokens);
    }
    case "openrouter": {
      const apiKey = resolveApiKey("openrouter", "OPENROUTER_API_KEY");
      if (!apiKey) throw new Error("OPENROUTER_API_KEY (or OPENAI_API_KEY alias) required for openrouter provider");
      return createOpenRouterClient(apiKey, modelConfig.modelId);
    }
    case "mistral": {
      const apiKey = process.env.MISTRAL_API_KEY;
      if (!apiKey) throw new Error("MISTRAL_API_KEY required for mistral provider");
      return createMistralClient(apiKey, modelConfig.modelId);
    }
    case "bedrock": {
      const region = process.env.AWS_REGION ?? "us-east-1";
      const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
      const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
      const credentials = accessKeyId && secretAccessKey
        ? { accessKeyId, secretAccessKey }
        : undefined;
      return createBedrockClient(region, modelConfig.modelId, credentials);
    }
    case "edge": {
      const edgeUrl = modelConfig.endpoint ?? process.env.EDGE_INFERENCE_URL ?? "http://localhost:8000";
      return createEdgeClient(modelConfig.modelId, edgeUrl);
    }
    default:
      throw new Error(`Unknown inference provider: ${modelConfig.provider}`);
  }
}

/** @deprecated Use getInferenceClientForAgent instead */
export function createInferenceClient(
  modelConfig: AgentConfig["model"],
): InferenceClient {
  const primary = createPrimaryClient(modelConfig);
  return createResilientClient({
    primary,
    fallback: getFallbackClient(),
    maxRetries: 2,
    baseDelayMs: 1000,
  });
}

// ── Per-Agent Client Map ─────────────────────────────────────────────
// Lazy cache keyed by provider:modelId:endpoint. Agents sharing the
// same model config reuse a single SDK instance.

const _clientMap = new Map<string, InferenceClient>();

function clientKey(config: AgentConfig["model"]): string {
  return `${config.provider}:${config.modelId}:${config.endpoint ?? "default"}`;
}

export function getInferenceClientForAgent(config: AgentConfig): InferenceClient {
  const key = clientKey(config.model);
  const cached = _clientMap.get(key);
  if (cached) return cached;

  // Check warm pool before creating new client
  const warmed = warmPool.get(config.model.provider, config.model.modelId);
  if (warmed) {
    _clientMap.set(key, warmed);
    return warmed;
  }

  const primary = createPrimaryClient(config.model);
  let client: InferenceClient = createResilientClient({
    primary,
    fallback: getFallbackClient(),
    maxRetries: 2,
    baseDelayMs: 1000,
  });

  // Wrap with semantic cache if enabled
  if (process.env.SEMANTIC_CACHE_ENABLED === "true") {
    client = withSemanticCache(client, config.id);
  }

  // Wrap with token prediction if enabled (feature 6)
  if (process.env.TOKEN_PREDICTION_ENABLED === "true") {
    client = withTokenPrediction(client, config);
  }

  _clientMap.set(key, client);
  return client;
}

/**
 * Wrap an inference client with pre-flight token usage prediction (feature 6).
 * If TOKEN_PREDICTION_ENABLED, checks predicted token count before inference
 * and logs warnings if confidence is high.
 */
function withTokenPrediction(
  client: InferenceClient,
  config: AgentConfig,
): InferenceClient {
  return {
    async chat(request) {
      // Pre-flight check: estimate token usage
      try {
        const messageLength = request.messages
          .reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0), 0);
        const prediction = await predictTokenUsage(
          config.id,
          config.model.modelId,
          messageLength,
        );

        // Log prediction if confidence is high
        if (prediction.confidence > 0.8) {
          console.debug(
            `[token-prediction] ${config.id}: ${prediction.totalTokens} tokens ` +
            `(${(prediction.confidence * 100).toFixed(0)}% confidence)`,
          );
        }
      } catch (err) {
        // Silently ignore prediction errors — don't fail inference on prediction failures
        console.debug(`[token-prediction] Error: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Proceed with normal inference
      return client.chat(request);
    },

    async *chatStream(request) {
      // Pre-flight check: estimate token usage
      try {
        const messageLength = request.messages
          .reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0), 0);
        const prediction = await predictTokenUsage(
          config.id,
          config.model.modelId,
          messageLength,
        );

        if (prediction.confidence > 0.8) {
          console.debug(
            `[token-prediction] ${config.id}: ${prediction.totalTokens} tokens ` +
            `(${(prediction.confidence * 100).toFixed(0)}% confidence)`,
          );
        }
      } catch (err) {
        console.debug(`[token-prediction] Error: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Proceed with streaming
      yield* client.chatStream(request);
    },
  };
}
