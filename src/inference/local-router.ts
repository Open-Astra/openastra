import type { InferenceClient, InferenceRequest, InferenceResponse, InferenceStreamDelta } from "./types.js";
import { isOllamaAvailable, listOllamaModels, warmupOllamaModel, createOllamaClient } from "./ollama.js";
import { createGrokClient } from "./grok.js";
import { estimateComplexity, estimateTokenCount } from "./router.js";
import { createLogger } from "../utils/logger.js";

// ── Ollama / vLLM Local-First Deep Integration + Model Router ───────
// Intelligent routing between local models (Ollama/vLLM) and cloud
// providers. Prefers local models when they can handle the task,
// falling back to cloud for complex/long-context requests.
//
// Features:
//   - Auto-discovery of available Ollama models
//   - Capability-based routing (code, reasoning, tool_calling)
//   - Local-first: always try local, fallback to cloud
//   - Model warm-up: preload models for faster first inference
//   - vLLM cluster support: multiple endpoints with load balancing
//   - Cost tracking: local = free, cloud = metered

const log = createLogger("local-router");

// ── Types ───────────────────────────────────────────────────────────

export interface LocalModel {
  id: string;
  name: string;
  provider: "ollama" | "vllm";
  endpoint: string;
  parameterSize?: string;
  quantization?: string;
  maxContext: number;
  capabilities: Set<string>;
  costPer1kTokens: number;     // 0 for local
  client: InferenceClient;
}

export interface VLLMEndpoint {
  url: string;
  modelId: string;
  apiKey?: string;
  maxContext?: number;
}

export interface LocalRouterConfig {
  ollamaBaseUrl: string;
  vllmEndpoints: VLLMEndpoint[];
  preferLocal: boolean;            // prefer local over cloud (default: true)
  cloudFallback?: InferenceClient; // cloud provider for fallback
  complexityThreshold: number;     // above this, prefer cloud (0-1, default: 0.7)
  contextThreshold: number;        // above this context size, prefer cloud (default: 32000)
  warmupOnStart: boolean;          // preload models on startup
}

const DEFAULT_CONFIG: LocalRouterConfig = {
  ollamaBaseUrl: "http://localhost:11434",
  vllmEndpoints: [],
  preferLocal: true,
  complexityThreshold: 0.7,
  contextThreshold: 32_000,
  warmupOnStart: false,
};

// ── Capability Detection ────────────────────────────────────────────

const MODEL_CAPABILITIES: Record<string, string[]> = {
  // Llama family
  "llama3": ["general", "reasoning", "tool_calling"],
  "llama3.1": ["general", "reasoning", "tool_calling", "code"],
  "llama3.2": ["general", "reasoning", "tool_calling"],
  "llama3.3": ["general", "reasoning", "tool_calling", "code"],
  // Code models
  "codellama": ["code", "reasoning"],
  "deepseek-coder": ["code", "reasoning", "tool_calling"],
  "qwen2.5-coder": ["code", "reasoning", "tool_calling"],
  // Reasoning models
  "deepseek-r1": ["reasoning", "general"],
  "qwq": ["reasoning", "general"],
  "qwen3.5": ["general", "reasoning", "tool_calling", "code"],
  "qwen3": ["general", "reasoning", "tool_calling", "code"],
  // Llama 4 vision models (MoE with ~17B active parameters)
  "llama-4-scout": ["general", "reasoning", "tool_calling", "vision"],
  "llama-4-maverick": ["general", "reasoning", "tool_calling", "vision"],
  "llama4": ["general", "reasoning", "tool_calling", "vision"],
  "llama-4": ["general", "reasoning", "tool_calling", "vision"],
  // Multimodal models
  "llava": ["general", "vision"],
  "bakllava": ["general", "vision"],
  // Small/fast models
  "phi3": ["general", "code"],
  "phi4": ["general", "code", "reasoning"],
  "gemma2": ["general"],
  "gemma4": ["general", "reasoning", "tool_calling", "code"],
  "mistral": ["general", "tool_calling"],
  "mixtral": ["general", "tool_calling", "reasoning"],
  // Embeddings
  "nomic-embed-text": ["embeddings"],
  "all-minilm": ["embeddings"],
  "mxbai-embed-large": ["embeddings"],
};

function detectCapabilities(modelName: string): Set<string> {
  const lower = modelName.toLowerCase();
  for (const [pattern, caps] of Object.entries(MODEL_CAPABILITIES)) {
    if (lower.includes(pattern)) {
      return new Set(caps);
    }
  }
  return new Set(["general"]);
}

function estimateMaxContext(modelName: string, _parameterSize?: string): number {
  const lower = modelName.toLowerCase();
  if (lower.includes("llama-4") || lower.includes("llama4")) return 131_072;
  if (lower.includes("llama3.1") || lower.includes("llama3.2") || lower.includes("llama3.3")) return 128_000;
  if (lower.includes("mistral") || lower.includes("mixtral")) return 32_000;
  if (lower.includes("deepseek")) return 64_000;
  if (lower.includes("gemma4")) return 128_000;
  if (lower.includes("qwen3")) return 128_000;
  if (lower.includes("qwen2.5")) return 128_000;
  if (lower.includes("phi4")) return 16_000;
  return 8_000; // conservative default
}

// ── Local Router ────────────────────────────────────────────────────

export class LocalModelRouter {
  private models: LocalModel[] = [];
  private config: LocalRouterConfig;
  private initialized = false;

  constructor(config: Partial<LocalRouterConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Discover available local models and build the routing table.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Discover Ollama models
    const ollamaAvailable = await isOllamaAvailable(this.config.ollamaBaseUrl);
    if (ollamaAvailable) {
      const ollamaModels = await listOllamaModels(this.config.ollamaBaseUrl);
      for (const model of ollamaModels) {
        // Skip embedding models
        if (detectCapabilities(model.name).has("embeddings")) continue;

        this.models.push({
          id: `ollama:${model.name}`,
          name: model.name,
          provider: "ollama",
          endpoint: this.config.ollamaBaseUrl,
          parameterSize: model.parameterSize,
          quantization: model.quantization,
          maxContext: estimateMaxContext(model.name, model.parameterSize),
          capabilities: detectCapabilities(model.name),
          costPer1kTokens: 0, // local = free
          client: createOllamaClient(model.name, this.config.ollamaBaseUrl, estimateMaxContext(model.name, model.parameterSize)),
        });
      }

      log.info(`Discovered ${this.models.length} Ollama models`);

      if (this.config.warmupOnStart && this.models.length > 0) {
        // Warm up the first model
        const primary = this.models[0]!;
        log.dim(`Warming up ${primary.name}...`);
        await warmupOllamaModel(primary.name, this.config.ollamaBaseUrl).catch(() => {});
      }
    }

    // Register vLLM endpoints
    for (const endpoint of this.config.vllmEndpoints) {
      this.models.push({
        id: `vllm:${endpoint.modelId}`,
        name: endpoint.modelId,
        provider: "vllm",
        endpoint: endpoint.url,
        maxContext: endpoint.maxContext ?? 32_000,
        capabilities: new Set(["general", "tool_calling", "reasoning", "code"]),
        costPer1kTokens: 0,
        client: createGrokClient(endpoint.apiKey ?? "no-key", endpoint.url, endpoint.modelId),
      });
    }

    this.initialized = true;
    log.info(`Local router initialized: ${this.models.length} models available`);
  }

  /**
   * Get available local models.
   */
  getAvailableModels(): LocalModel[] {
    return [...this.models];
  }

  /**
   * Select the best local model for a request.
   */
  selectModel(request: InferenceRequest): LocalModel | null {
    if (this.models.length === 0) return null;

    const tokenEstimate = estimateTokenCount(request.messages);
    const needsTools = (request.tools?.length ?? 0) > 0;

    // Check if request contains images (needs vision-capable model)
    const needsVision = request.messages.some(
      (m) => Array.isArray(m.content) && m.content.some((p: any) => p.type === "image_url"),
    );

    // Filter by capability
    const eligible = this.models.filter((m) => {
      if (tokenEstimate > m.maxContext * 0.8) return false;
      if (needsTools && !m.capabilities.has("tool_calling")) return false;
      if (needsVision && !m.capabilities.has("vision")) return false;
      return true;
    });

    if (eligible.length === 0) return null;

    // Prefer larger models for complex tasks, smaller for simple
    const complexity = estimateComplexity(request.messages);
    if (complexity > 0.6) {
      // Prefer largest model
      eligible.sort((a, b) => b.maxContext - a.maxContext);
    } else {
      // Prefer fastest (smallest) model
      eligible.sort((a, b) => a.maxContext - b.maxContext);
    }

    return eligible[0] ?? null;
  }

  /**
   * Create an inference client that routes to local models first,
   * falling back to cloud if needed.
   */
  createClient(): InferenceClient {
    return {
      chat: async (request: InferenceRequest): Promise<InferenceResponse> => {
        await this.initialize();

        const complexity = estimateComplexity(request.messages);
        const tokenEstimate = estimateTokenCount(request.messages);

        // If complex or long context and cloud fallback exists, go to cloud
        if (
          this.config.cloudFallback &&
          (complexity > this.config.complexityThreshold ||
            tokenEstimate > this.config.contextThreshold)
        ) {
          if (!this.config.preferLocal) {
            log.dim(`Routing to cloud (complexity: ${complexity.toFixed(2)}, tokens: ~${tokenEstimate})`);
            return this.config.cloudFallback.chat(request);
          }
        }

        // Try local
        const model = this.selectModel(request);
        if (model) {
          try {
            log.dim(`Routing to ${model.id} (complexity: ${complexity.toFixed(2)})`);
            return await model.client.chat(request);
          } catch (err) {
            log.dim(`Local model ${model.id} failed, falling back to cloud`);
            if (this.config.cloudFallback) {
              return this.config.cloudFallback.chat(request);
            }
            throw err;
          }
        }

        // No local model available — use cloud
        if (this.config.cloudFallback) {
          return this.config.cloudFallback.chat(request);
        }

        throw new Error("No local models available and no cloud fallback configured");
      },

      chatStream: async function* (request: InferenceRequest): AsyncIterable<InferenceStreamDelta> {
        // For streaming, same routing logic
        const self = this as unknown as { chat: (r: InferenceRequest) => Promise<InferenceResponse> };
        const response = await self.chat(request);
        // Simulate stream from non-stream response
        if (response.content) {
          yield { type: "content", content: response.content };
        }
        yield {
          type: "done",
          usage: response.usage,
        };
      },
    };
  }

  /**
   * Refresh the model list (e.g., after pulling new models).
   */
  async refresh(): Promise<void> {
    this.models = [];
    this.initialized = false;
    await this.initialize();
  }
}

// ── Module Singleton ────────────────────────────────────────────────

let _router: LocalModelRouter | null = null;

export function getLocalRouter(config?: Partial<LocalRouterConfig>): LocalModelRouter {
  if (!_router) {
    _router = new LocalModelRouter(config);
  }
  return _router;
}

export async function initLocalRouter(config?: Partial<LocalRouterConfig>): Promise<LocalModelRouter> {
  const router = getLocalRouter(config);
  await router.initialize();
  return router;
}
