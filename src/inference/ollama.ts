import OpenAI from "openai";
import type {
  InferenceClient,
  InferenceRequest,
  InferenceResponse,
  InferenceStreamDelta,
} from "./types.js";
import { logCacheMetrics } from "./cache-metrics.js";

// ── Ollama Client ──────────────────────────────────────────────────
// First-class local model support via Ollama's OpenAI-compatible API.
// Ollama runs models like Llama 3, Mistral, Phi-3, Qwen, DeepSeek,
// CodeLlama, etc. on consumer hardware with GPU acceleration.
//
// Usage:
//   provider: "ollama"
//   modelId: "llama3.1:70b" (or any Ollama model tag)
//   endpoint: "http://localhost:11434/v1" (default)
//
// Features:
//   - Auto-detection: probes Ollama API on startup
//   - Model listing: enumerates available local models
//   - Warm-up: optional model preloading for faster first inference
//   - Tool calling: supports Ollama's function calling (Llama 3.1+)

const DEFAULT_OLLAMA_URL = "http://localhost:11434";

export interface OllamaModelInfo {
  name: string;
  size: number;
  modifiedAt: string;
  parameterSize?: string;
  quantization?: string;
}

/**
 * Check if Ollama is running and reachable.
 */
export async function isOllamaAvailable(baseUrl: string = DEFAULT_OLLAMA_URL): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000);
    const res = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * List all models available in the local Ollama instance.
 */
export async function listOllamaModels(baseUrl: string = DEFAULT_OLLAMA_URL): Promise<OllamaModelInfo[]> {
  const res = await fetch(`${baseUrl}/api/tags`);
  if (!res.ok) throw new Error(`Ollama API error: ${res.status}`);

  const data = (await res.json()) as {
    models: Array<{
      name: string;
      size: number;
      modified_at: string;
      details?: { parameter_size?: string; quantization_level?: string };
    }>;
  };

  return (data.models ?? []).map((m) => ({
    name: m.name,
    size: m.size,
    modifiedAt: m.modified_at,
    parameterSize: m.details?.parameter_size,
    quantization: m.details?.quantization_level,
  }));
}

/**
 * Preload a model into Ollama's memory for faster first inference.
 */
export async function warmupOllamaModel(
  modelId: string,
  baseUrl: string = DEFAULT_OLLAMA_URL,
): Promise<void> {
  await fetch(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelId, prompt: "", keep_alive: "5m" }),
  });
}

/**
 * Create an inference client backed by a local Ollama model.
 * Uses the OpenAI-compatible endpoint at /v1 for chat completions.
 */
export function createOllamaClient(
  modelId: string,
  baseUrl: string = DEFAULT_OLLAMA_URL,
  numCtx?: number,
): InferenceClient {
  const client = new OpenAI({
    apiKey: "ollama", // Ollama ignores API keys but the SDK requires one
    baseURL: `${baseUrl}/v1`,
  });

  // Ollama-specific options passed alongside the OpenAI-compatible request.
  // num_ctx controls the KV-cache size and directly impacts VRAM usage.
  const ollamaOptions = numCtx ? { num_ctx: numCtx } : undefined;

  return {
    async chat(request: InferenceRequest): Promise<InferenceResponse> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ollama accepts `options.num_ctx` beyond the OpenAI spec
      const response = await client.chat.completions.create({
        model: modelId,
        messages: request.messages as OpenAI.ChatCompletionMessageParam[],
        tools: request.tools as OpenAI.ChatCompletionTool[] | undefined,
        temperature: request.temperature ?? 0.7,
        max_tokens: request.maxTokens,
        stream: false,
        ...ollamaOptions && { options: ollamaOptions },
      } as any);

      const choice = response.choices[0]!;

      const usage: InferenceResponse["usage"] = {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
        cachedTokens: 0,
      };

      logCacheMetrics("ollama", usage);

      return {
        content: choice.message.content,
        toolCalls:
          choice.message.tool_calls
            ?.filter((tc): tc is Extract<typeof tc, { type: "function" }> => tc.type === "function")
            .map((tc) => ({
              id: tc.id,
              name: tc.function.name,
              arguments: tc.function.arguments,
            })) ?? [],
        usage,
        finishReason:
          choice.finish_reason === "tool_calls"
            ? "tool_calls"
            : choice.finish_reason === "length"
              ? "length"
              : "stop",
      };
    },

    async *chatStream(
      request: InferenceRequest,
    ): AsyncIterable<InferenceStreamDelta> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ollama accepts `options.num_ctx` beyond the OpenAI spec
      const stream = await client.chat.completions.create({
        model: modelId,
        messages: request.messages as OpenAI.ChatCompletionMessageParam[],
        tools: request.tools as OpenAI.ChatCompletionTool[] | undefined,
        temperature: request.temperature ?? 0.7,
        max_tokens: request.maxTokens,
        stream: true,
        ...ollamaOptions && { options: ollamaOptions },
      } as any) as unknown as AsyncIterable<OpenAI.ChatCompletionChunk>;

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;

        if (!delta && chunk.usage) {
          yield {
            type: "done",
            usage: {
              promptTokens: chunk.usage.prompt_tokens ?? 0,
              completionTokens: chunk.usage.completion_tokens ?? 0,
              totalTokens: chunk.usage.total_tokens ?? 0,
            },
          };
          continue;
        }

        if (delta?.content) {
          yield { type: "content", content: delta.content };
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            yield {
              type: "tool_call",
              toolCall: {
                index: tc.index,
                id: tc.id,
                name: tc.function?.name,
                arguments: tc.function?.arguments,
              },
            };
          }
        }
      }
    },
  };
}

/**
 * Generate embeddings using Ollama's local embedding models.
 * Supports nomic-embed-text, all-minilm, mxbai-embed-large, etc.
 */
export async function generateOllamaEmbedding(
  text: string,
  model: string = "nomic-embed-text",
  baseUrl: string = DEFAULT_OLLAMA_URL,
): Promise<number[]> {
  const res = await fetch(`${baseUrl}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: text }),
  });

  if (!res.ok) throw new Error(`Ollama embedding error: ${res.status}`);

  const data = (await res.json()) as { embedding: number[] };
  return data.embedding;
}

/**
 * Batch generate embeddings via Ollama.
 */
export async function generateOllamaEmbeddings(
  texts: string[],
  model: string = "nomic-embed-text",
  baseUrl: string = DEFAULT_OLLAMA_URL,
): Promise<number[][]> {
  // Ollama doesn't have a batch endpoint — parallelize with concurrency limit
  const CONCURRENCY = 4;
  const results: number[][] = new Array(texts.length);

  for (let i = 0; i < texts.length; i += CONCURRENCY) {
    const batch = texts.slice(i, i + CONCURRENCY);
    const embeddings = await Promise.all(
      batch.map((text) => generateOllamaEmbedding(text, model, baseUrl)),
    );
    for (let j = 0; j < embeddings.length; j++) {
      results[i + j] = embeddings[j]!;
    }
  }

  return results;
}
