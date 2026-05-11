import { GoogleGenAI } from "@google/genai";
import type {
  Content,
  Part,
  FunctionDeclaration,
} from "@google/genai";
import type {
  ChatMessage,
  InferenceClient,
  InferenceRequest,
  InferenceResponse,
  InferenceStreamDelta,
  ToolSchema,
} from "./types.js";
import { contentAsString } from "./types.js";
import { logCacheMetrics } from "./cache-metrics.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("gemini");

// ── Explicit Cache Manager ──────────────────────────────────────────
// Best-effort caching for system prompts >2048 tokens via the REST API.
// Logs failures for diagnostics, then falls back to inline.

const TOKEN_THRESHOLD = 2048;
const CACHE_TTL_SECONDS = 600;

/** Map of contentHash → cached content resource name */
const cacheNames = new Map<string, string>();

function simpleHash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

/** Rough token estimate: ~4 chars per token */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface CacheableContent {
  systemInstruction?: string;
  tools?: ToolSchema[];
}

async function getOrCreateCache(
  apiKey: string,
  modelId: string,
  content: CacheableContent,
): Promise<string | null> {
  const systemTokens = content.systemInstruction ? estimateTokens(content.systemInstruction) : 0;
  const toolTokens = content.tools ? estimateTokens(JSON.stringify(content.tools)) : 0;
  if (systemTokens + toolTokens < TOKEN_THRESHOLD) return null;

  const hashInput = (content.systemInstruction ?? "") + JSON.stringify(content.tools ?? []);
  const hash = simpleHash(hashInput);
  const existing = cacheNames.get(hash);
  if (existing) return existing;

  try {
    const cacheBody: Record<string, unknown> = {
      model: `models/${modelId}`,
      displayName: `sys-${hash}`,
      contents: [
        {
          role: "user",
          parts: [{ text: content.systemInstruction ?? "" }],
        },
      ],
      ttl: `${CACHE_TTL_SECONDS}s`,
    };

    if (content.systemInstruction) {
      cacheBody.systemInstruction = {
        parts: [{ text: content.systemInstruction }],
      };
    }

    if (content.tools && content.tools.length > 0) {
      cacheBody.tools = [
        {
          functionDeclarations: content.tools.map((t) => ({
            name: t.function.name,
            description: t.function.description,
            parameters: sanitizeSchemaForGemini(t.function.parameters),
          })),
        },
      ];
    }

    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/cachedContents`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(cacheBody),
      },
    );

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      log.warn("Cache creation failed: %d %s — %s", resp.status, resp.statusText, body.slice(0, 200));
      return null;
    }

    const data = (await resp.json()) as { name?: string };
    if (data.name) {
      cacheNames.set(hash, data.name);
      log.info("Cache created: %s (est. %d tokens)", data.name, estimateTokens(hashInput));
      return data.name;
    }
  } catch (err) {
    log.warn("Cache creation error: %s", (err as Error).message ?? err);
  }

  return null;
}

// ── Message Conversion ──────────────────────────────────────────────

interface ConvertedMessages {
  systemInstruction: string | undefined;
  contents: Content[];
}

function convertMessages(messages: ChatMessage[]): ConvertedMessages {
  let systemInstruction: string | undefined;
  const contents: Content[] = [];

  // Build a map of tool_call_id → function name from assistant tool_calls
  const toolCallIdToName = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        toolCallIdToName.set(tc.id, tc.function.name);
      }
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "system") {
      const sysText = contentAsString(msg.content);
      systemInstruction = systemInstruction
        ? `${systemInstruction}\n\n${sysText}`
        : sysText;
      continue;
    }

    if (msg.role === "user") {
      contents.push({
        role: "user",
        parts: [{ text: contentAsString(msg.content) }],
      });
      continue;
    }

    if (msg.role === "assistant") {
      const parts: Part[] = [];
      const assistantText = contentAsString(msg.content);

      if (assistantText) {
        parts.push({ text: assistantText });
      }

      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const part: Part = {
            functionCall: {
              name: tc.function.name,
              args: JSON.parse(tc.function.arguments),
            },
          };
          // Gemini 3.0+: pass back thought signatures to preserve reasoning
          if (tc.thoughtSignature) {
            part.thoughtSignature = tc.thoughtSignature;
          }
          parts.push(part);
        }
      }

      if (parts.length > 0) {
        contents.push({ role: "model", parts });
      }
      continue;
    }

    if (msg.role === "tool") {
      // Gemini requires ALL function responses for parallel calls in a
      // single user Content — NOT separate Content entries per response.
      // Collect this and all consecutive tool messages into one Content.
      const frParts: Part[] = [];

      let j = i;
      while (j < messages.length && messages[j].role === "tool") {
        const toolMsg = messages[j];
        const fnName = toolMsg.tool_call_id
          ? toolCallIdToName.get(toolMsg.tool_call_id) ?? "unknown"
          : "unknown";
        frParts.push({
          functionResponse: {
            name: fnName,
            response: { result: contentAsString(toolMsg.content) },
          },
        });
        j++;
      }

      contents.push({ role: "user", parts: frParts });
      // Skip ahead past the tool messages we just consumed
      i = j - 1;
      continue;
    }
  }

  return { systemInstruction, contents };
}

// ── Schema Sanitization ─────────────────────────────────────────────
// Gemini's function declaration API only supports a subset of JSON Schema.
// Recursively strip unsupported fields before sending.

const UNSUPPORTED_KEYS = new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  "additionalProperties",
  "propertyNames",
  "patternProperties",
  "if",
  "then",
  "else",
  "allOf",
  "oneOf",
  "not",
  "contentMediaType",
  "contentEncoding",
  "default",
]);

function sanitizeSchemaForGemini(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeSchemaForGemini);
  if (typeof obj !== "object") return obj;

  const input = obj as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (UNSUPPORTED_KEYS.has(key)) continue;

    if (key === "exclusiveMinimum" && typeof value === "number") {
      if (out["minimum"] === undefined) out["minimum"] = value;
      continue;
    }
    if (key === "exclusiveMaximum" && typeof value === "number") {
      if (out["maximum"] === undefined) out["maximum"] = value;
      continue;
    }

    out[key] = sanitizeSchemaForGemini(value);
  }

  return out;
}

// ── Tool Conversion ─────────────────────────────────────────────────

function convertTools(
  tools: ToolSchema[] | undefined,
): FunctionDeclaration[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: sanitizeSchemaForGemini(
      t.function.parameters,
    ) as Record<string, unknown>,
  }));
}

// ── Response Helpers ────────────────────────────────────────────────

function extractUsage(
  meta: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number; cachedContentTokenCount?: number } | undefined,
): InferenceResponse["usage"] {
  return {
    promptTokens: meta?.promptTokenCount ?? 0,
    completionTokens: meta?.candidatesTokenCount ?? 0,
    totalTokens: meta?.totalTokenCount ?? 0,
    cachedTokens: meta?.cachedContentTokenCount ?? undefined,
  };
}

function mapFinishReason(
  reason: string | undefined,
  hasFunctionCalls: boolean,
): InferenceResponse["finishReason"] {
  if (hasFunctionCalls) return "tool_calls";
  if (reason === "MAX_TOKENS") return "length";
  return "stop";
}

/** Extract tool calls from response parts, preserving thoughtSignature.
 *  Gemini thinking models return thoughtSignature only on the first
 *  functionCall part per response, but require it on ALL parts when
 *  sent back. Propagate the first signature to subsequent parts. */
function extractToolCalls(
  parts: Part[],
): Array<{ id: string; name: string; arguments: string; thoughtSignature?: string }> {
  const toolCalls: Array<{ id: string; name: string; arguments: string; thoughtSignature?: string }> = [];

  // Find the first thoughtSignature among functionCall parts
  let fallbackSig: string | undefined;
  for (const part of parts) {
    if (part.functionCall && part.thoughtSignature) {
      fallbackSig = part.thoughtSignature;
      break;
    }
  }

  let callIdx = 0;
  for (const part of parts) {
    if (part.functionCall) {
      const fc = part.functionCall;
      const sig = part.thoughtSignature ?? fallbackSig;
      toolCalls.push({
        id: `call_${fc.name}_${callIdx}`,
        name: fc.name!,
        arguments: JSON.stringify(fc.args),
        ...(sig ? { thoughtSignature: sig } : {}),
      });
      callIdx++;
    }
  }
  return toolCalls;
}

// ── Gemini Client ───────────────────────────────────────────────────

export function createGeminiClient(
  apiKey: string,
  modelId: string,
): InferenceClient {
  const ai = new GoogleGenAI({ apiKey });

  return {
    async chat(request: InferenceRequest): Promise<InferenceResponse> {
      const { systemInstruction, contents } = convertMessages(
        request.messages,
      );
      const tools = convertTools(request.tools);

      // Attempt explicit cache for system prompt + tools together
      let cachedContent: string | undefined;
      if (systemInstruction) {
        const cacheName = await getOrCreateCache(apiKey, modelId, {
          systemInstruction,
          tools: request.tools,
        });
        if (cacheName) cachedContent = cacheName;
      }

      const response = await ai.models.generateContent({
        model: modelId,
        contents,
        config: {
          temperature: request.temperature ?? 0.7,
          maxOutputTokens: request.maxTokens,
          ...(cachedContent
            ? {}
            : {
                ...(tools ? { tools: [{ functionDeclarations: tools }] } : {}),
                ...(systemInstruction ? { systemInstruction } : {}),
              }),
          ...(cachedContent ? { cachedContent } : {}),
        },
      });

      const candidate = response.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];
      const toolCalls = extractToolCalls(parts);

      const usage = extractUsage(response.usageMetadata);
      logCacheMetrics("gemini", usage);

      // Extract text without triggering SDK warning about non-text parts
      let text: string | null = null;
      if (toolCalls.length === 0) {
        text = response.text ?? null;
      } else {
        // Manually extract text parts to avoid SDK "non-text parts" warning
        text = parts
          .filter((p) => p.text && !p.thought)
          .map((p) => p.text)
          .join("") || null;
      }

      return {
        content: text,
        toolCalls,
        usage,
        finishReason: mapFinishReason(
          candidate?.finishReason,
          toolCalls.length > 0,
        ),
      };
    },

    async *chatStream(
      request: InferenceRequest,
    ): AsyncIterable<InferenceStreamDelta> {
      // Use non-streaming internally: Gemini's streaming API only includes
      // thoughtSignature on the first functionCall part per chunk, but the
      // API requires it on ALL parts when sent back. Non-streaming returns
      // complete parts with all signatures intact.
      const response = await this.chat(request);

      if (response.content) {
        yield { type: "content", content: response.content };
      }

      let callIndex = 0;
      for (const tc of response.toolCalls) {
        yield {
          type: "tool_call",
          toolCall: {
            index: callIndex,
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
            ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
          },
        };
        callIndex++;
      }

      yield { type: "done", usage: response.usage };
    },
  };
}
