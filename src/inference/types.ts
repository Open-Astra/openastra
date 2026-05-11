// ── Inference Types ──────────────────────────────────────────────────
// Provider-agnostic types for the LLM inference layer.
// Both Grok and vLLM expose OpenAI-compatible APIs, so these types
// map cleanly to the OpenAI chat completion format.

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
    thoughtSignature?: string; // Gemini 3.0: encrypted reasoning state
  }>;
  tool_call_id?: string;
}

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

export interface InferenceRequest {
  messages: ChatMessage[];
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  sessionId?: string; // Grok: x-grok-conv-id cache pinning
  /** Wall-clock timeout in ms for the resilient layer. Default: 60_000. */
  timeoutMs?: number;
  /** When true and provider is openrouter, send X-OpenRouter-Cache: true header. */
  cache?: boolean;
  // Feature 10: Extended thinking
  useExtendedThinking?: boolean;
  budgetThinkingTokens?: number;
}

export interface InferenceResponse {
  content: string | null;
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: string;
    thoughtSignature?: string; // Gemini 3.0: pass back to preserve reasoning
  }>;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens?: number;
    cacheCreationTokens?: number;
    // Feature 10: Extended thinking tokens
    thinkingTokens?: number;
  };
  finishReason: "stop" | "tool_calls" | "length";
}

// ── Streaming ───────────────────────────────────────────────────────

export interface InferenceStreamDelta {
  type: "content" | "tool_call" | "done";
  content?: string;
  toolCall?: {
    index: number;
    id?: string;
    name?: string;
    arguments?: string; // partial JSON chunk
    thoughtSignature?: string; // Gemini 3.0
  };
  usage?: InferenceResponse["usage"];
}

// ── Content Helpers ─────────────────────────────────────────────────

/** Extract plain text from a ChatMessage content field. */
export function contentAsString(content: string | ContentPart[] | null): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");
  }
  return "";
}

// ── Inference Client Interface ──────────────────────────────────────

export interface InferenceClient {
  chat(request: InferenceRequest): Promise<InferenceResponse>;
  chatStream(
    request: InferenceRequest,
  ): AsyncIterable<InferenceStreamDelta>;
}

// ── Inference Errors ────────────────────────────────────────────────

export class InferenceTimeoutError extends Error {
  constructor(public provider: string, public timeoutMs: number) {
    super(`Inference timeout after ${timeoutMs}ms (provider: ${provider})`);
    this.name = "InferenceTimeoutError";
  }
}
