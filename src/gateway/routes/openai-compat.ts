import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import { createLogger } from "../../utils/logger.js";
import { getAllAgentConfigs } from "../../config/agents.js";
import { createInferenceClient } from "../../inference/factory.js";
import type { ChatMessage, InferenceRequest } from "../../inference/types.js";

const logger = createLogger("openai-compat");

// ── OpenAI-Compatible API ──────────────────────────────────────────
// Exposes /v1/chat/completions, /v1/models, and /v1/embeddings in the
// exact format OpenAI clients expect. Lets any OpenAI SDK, LangChain,
// LlamaIndex, Cursor, or similar tool use Astra as a backend.
//
// Auth: Bearer token matching OPENAI_COMPAT_API_KEY or INTERNAL_API_KEY.

// ── Request Schemas ────────────────────────────────────────────────

const ChatCompletionMessage = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.null()]).default(null),
  name: z.string().optional(),
  tool_calls: z.array(z.object({
    id: z.string(),
    type: z.literal("function"),
    function: z.object({
      name: z.string(),
      arguments: z.string(),
    }),
  })).optional(),
  tool_call_id: z.string().optional(),
});

const ChatCompletionRequest = z.object({
  model: z.string(),
  messages: z.array(ChatCompletionMessage).min(1),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  stream: z.boolean().default(false),
  tools: z.array(z.object({
    type: z.literal("function"),
    function: z.object({
      name: z.string(),
      description: z.string().optional(),
      parameters: z.record(z.string(), z.unknown()).optional(),
    }),
  })).optional(),
  n: z.number().int().positive().default(1),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  top_p: z.number().min(0).max(1).optional(),
  frequency_penalty: z.number().optional(),
  presence_penalty: z.number().optional(),
  user: z.string().optional(),
});

const EmbeddingRequest = z.object({
  model: z.string(),
  input: z.union([z.string(), z.array(z.string())]),
  encoding_format: z.enum(["float", "base64"]).default("float"),
});

// ── Model ID → Provider Mapping ────────────────────────────────────
// Maps OpenAI-style model IDs to Astra provider configs.
// Falls back to exact match against registered agent model IDs.

interface ProviderMapping {
  provider: "grok" | "groq" | "openai" | "gemini" | "claude" | "vllm" | "ollama" | "openrouter" | "mistral" | "bedrock" | "edge";
  modelId: string;
}

function resolveModel(model: string): ProviderMapping | null {
  // Direct provider prefix: "claude:claude-sonnet-4-20250514"
  const prefixMatch = model.match(/^(grok|groq|openai|gemini|claude|vllm|ollama|openrouter|mistral|bedrock|edge):(.+)$/);
  if (prefixMatch) {
    return { provider: prefixMatch[1] as ProviderMapping["provider"], modelId: prefixMatch[2]! };
  }

  // Well-known model name patterns
  if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3") || model.startsWith("o4")) {
    return { provider: "openai", modelId: model };
  }
  if (model.startsWith("claude-")) {
    return { provider: "claude", modelId: model };
  }
  if (model.startsWith("gemini-")) {
    return { provider: "gemini", modelId: model };
  }
  if (model.startsWith("grok-")) {
    return { provider: "grok", modelId: model };
  }
  if (model.startsWith("llama") || model.startsWith("mixtral") || model.startsWith("gemma")) {
    // Groq hosts these open models
    return { provider: "groq", modelId: model };
  }
  if (model.startsWith("mistral-")) {
    return { provider: "mistral", modelId: model };
  }

  // Check if any registered agent uses this exact model ID
  const agents = getAllAgentConfigs();
  for (const [, agent] of agents) {
    if (agent.model.modelId === model) {
      return { provider: agent.model.provider, modelId: agent.model.modelId };
    }
  }

  return null;
}

// ── Auth Middleware ─────────────────────────────────────────────────

function apiKeyAuth(req: Request, res: Response): boolean {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({
      error: { message: "Missing API key in Authorization header", type: "invalid_request_error", code: "missing_api_key" },
    });
    return false;
  }

  const provided = authHeader.slice(7);
  const expected = process.env.OPENAI_COMPAT_API_KEY ?? process.env.INTERNAL_API_KEY;

  if (!expected) {
    res.status(500).json({
      error: { message: "Server not configured for OpenAI-compat API. Set OPENAI_COMPAT_API_KEY.", type: "server_error" },
    });
    return false;
  }

  try {
    const providedBuf = Buffer.from(provided);
    const expectedBuf = Buffer.from(expected);
    if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
      throw new Error("mismatch");
    }
  } catch {
    res.status(401).json({
      error: { message: "Invalid API key", type: "invalid_request_error", code: "invalid_api_key" },
    });
    return false;
  }

  return true;
}

// ── Response Helpers ───────────────────────────────────────────────

function makeCompletionResponse(
  id: string,
  model: string,
  content: string | null,
  toolCalls: Array<{ id: string; name: string; arguments: string }> | undefined,
  usage: { promptTokens: number; completionTokens: number; totalTokens: number },
  finishReason: string,
) {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content,
        ...(toolCalls?.length ? {
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        } : {}),
      },
      finish_reason: finishReason === "tool_calls" ? "tool_calls" : finishReason === "length" ? "length" : "stop",
    }],
    usage: {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.totalTokens,
    },
  };
}

function makeStreamChunk(
  id: string,
  model: string,
  delta: { role?: string; content?: string; tool_calls?: unknown[] },
  finishReason: string | null,
) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta,
      finish_reason: finishReason,
    }],
  };
}

// ── Router ─────────────────────────────────────────────────────────

export function createOpenAICompatRouter(): Router {
  const router = Router();

  // GET /v1/models — list available models
  router.get("/v1/models", (req, res) => {
    if (!apiKeyAuth(req, res)) return;

    const agents = getAllAgentConfigs();
    const seen = new Set<string>();
    const models: Array<{ id: string; object: string; created: number; owned_by: string }> = [];

    for (const [, agent] of agents) {
      const key = `${agent.model.provider}:${agent.model.modelId}`;
      if (seen.has(key)) continue;
      seen.add(key);

      models.push({
        id: agent.model.modelId,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: agent.model.provider,
      });
    }

    res.json({ object: "list", data: models });
  });

  // GET /v1/models/:model — retrieve a single model
  router.get("/v1/models/:model", (req, res) => {
    if (!apiKeyAuth(req, res)) return;

    const mapping = resolveModel(req.params.model!);
    if (!mapping) {
      res.status(404).json({
        error: { message: `Model '${req.params.model}' not found`, type: "invalid_request_error", code: "model_not_found" },
      });
      return;
    }

    res.json({
      id: mapping.modelId,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: mapping.provider,
    });
  });

  // POST /v1/chat/completions — create a chat completion
  router.post("/v1/chat/completions", async (req, res) => {
    if (!apiKeyAuth(req, res)) return;

    const parsed = ChatCompletionRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { message: `Invalid request: ${parsed.error.issues.map((i) => i.message).join(", ")}`, type: "invalid_request_error" },
      });
      return;
    }

    const body = parsed.data;
    const mapping = resolveModel(body.model);
    if (!mapping) {
      res.status(404).json({
        error: { message: `Model '${body.model}' not found. Use provider:model format (e.g. claude:claude-sonnet-4-20250514) or a known model name.`, type: "invalid_request_error", code: "model_not_found" },
      });
      return;
    }

    // Build Astra InferenceRequest from OpenAI format
    const messages: ChatMessage[] = body.messages.map((m) => ({
      role: m.role,
      content: m.content,
      tool_calls: m.tool_calls,
      tool_call_id: m.tool_call_id,
    }));

    const inferenceReq: InferenceRequest = {
      messages,
      temperature: body.temperature,
      maxTokens: body.max_completion_tokens ?? body.max_tokens,
      tools: body.tools?.map((t) => ({
        type: "function" as const,
        function: {
          name: t.function.name,
          description: t.function.description ?? "",
          parameters: t.function.parameters ?? {},
        },
      })),
    };

    const completionId = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;

    try {
      const client = createInferenceClient({
        provider: mapping.provider,
        modelId: mapping.modelId,
        maxContextTokens: 128000,
        maxOutputTokens: body.max_completion_tokens ?? body.max_tokens ?? 4096,
        temperature: body.temperature ?? 0.7,
      });

      if (body.stream) {
        // SSE streaming response
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");

        // Send initial role chunk
        const roleChunk = makeStreamChunk(completionId, body.model, { role: "assistant" }, null);
        res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

        try {
          const stream = client.chatStream(inferenceReq);

          // Accumulate tool calls for streaming
          const toolCallAccumulator = new Map<number, { id: string; name: string; arguments: string }>();

          for await (const delta of stream) {
            if (delta.type === "content" && delta.content) {
              const chunk = makeStreamChunk(completionId, body.model, { content: delta.content }, null);
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            } else if (delta.type === "tool_call" && delta.toolCall) {
              const tc = delta.toolCall;
              const idx = tc.index;
              if (!toolCallAccumulator.has(idx)) {
                toolCallAccumulator.set(idx, { id: tc.id ?? `call_${randomUUID().slice(0, 8)}`, name: tc.name ?? "", arguments: "" });
              }
              const acc = toolCallAccumulator.get(idx)!;
              if (tc.name) acc.name = tc.name;
              if (tc.arguments) acc.arguments += tc.arguments;

              // Stream tool call deltas
              const toolCallDelta: Record<string, unknown> = {
                tool_calls: [{
                  index: idx,
                  ...(tc.id ? { id: tc.id, type: "function" } : {}),
                  function: {
                    ...(tc.name ? { name: tc.name } : {}),
                    ...(tc.arguments ? { arguments: tc.arguments } : {}),
                  },
                }],
              };
              const chunk = makeStreamChunk(completionId, body.model, toolCallDelta as Record<string, string>, null);
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            } else if (delta.type === "done") {
              const finishReason = toolCallAccumulator.size > 0 ? "tool_calls" : "stop";
              const doneChunk = makeStreamChunk(completionId, body.model, {}, finishReason);
              res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);

              // Usage chunk (OpenAI format)
              if (delta.usage) {
                const usageChunk = {
                  id: completionId,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: body.model,
                  choices: [],
                  usage: {
                    prompt_tokens: delta.usage.promptTokens,
                    completion_tokens: delta.usage.completionTokens,
                    total_tokens: delta.usage.totalTokens,
                  },
                };
                res.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
              }
            }
          }
        } catch (err) {
          const errorChunk = { error: { message: err instanceof Error ? err.message : String(err), type: "server_error" } };
          res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
        }

        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        // Non-streaming response
        const response = await client.chat(inferenceReq);
        const result = makeCompletionResponse(
          completionId,
          body.model,
          response.content,
          response.toolCalls.length > 0 ? response.toolCalls : undefined,
          response.usage,
          response.finishReason,
        );
        res.json(result);
      }
    } catch (err) {
      logger.error("OpenAI-compat chat error:", err);
      res.status(500).json({
        error: { message: err instanceof Error ? err.message : "Internal server error", type: "server_error" },
      });
    }
  });

  // POST /v1/embeddings — create embeddings
  router.post("/v1/embeddings", async (req, res) => {
    if (!apiKeyAuth(req, res)) return;

    const parsed = EmbeddingRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { message: `Invalid request: ${parsed.error.issues.map((i) => i.message).join(", ")}`, type: "invalid_request_error" },
      });
      return;
    }

    const { input } = parsed.data;
    const texts = Array.isArray(input) ? input : [input];

    try {
      const { generateEmbedding } = await import("../../memory/embeddings.js");
      const embeddings = await Promise.all(texts.map((text) => generateEmbedding(text)));

      res.json({
        object: "list",
        data: embeddings.map((embedding, i) => ({
          object: "embedding",
          index: i,
          embedding,
        })),
        model: parsed.data.model,
        usage: {
          prompt_tokens: texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0),
          total_tokens: texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0),
        },
      });
    } catch (err) {
      logger.error("OpenAI-compat embedding error:", err);
      res.status(500).json({
        error: { message: err instanceof Error ? err.message : "Internal server error", type: "server_error" },
      });
    }
  });

  return router;
}
