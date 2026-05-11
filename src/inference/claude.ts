import Anthropic from "@anthropic-ai/sdk";
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

// ── Anthropic Message Types ─────────────────────────────────────────
// Local type aliases for the Anthropic API shapes we construct.

type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
};

type AnthropicContentBlock =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | { type: "image"; source: { type: "url"; url: string }; cache_control?: { type: "ephemeral" } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string | undefined };

type AnthropicSystemBlock = {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
};

type AnthropicTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: { type: "ephemeral" };
};

// ── Helpers ─────────────────────────────────────────────────────────

function extractSystemBlocks(messages: ChatMessage[]): AnthropicSystemBlock[] {
  const blocks: AnthropicSystemBlock[] = messages
    .filter((m) => m.role === "system" && m.content)
    .map((m) => ({ type: "text" as const, text: contentAsString(m.content) }));

  // Cache breakpoint 1: mark the last system block as ephemeral
  if (blocks.length > 0) {
    blocks[blocks.length - 1]!.cache_control = { type: "ephemeral" };
  }

  return blocks;
}

function convertTools(tools: ToolSchema[]): AnthropicTool[] {
  const converted: AnthropicTool[] = tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));

  // Cache breakpoint 2: mark the last tool as ephemeral
  if (converted.length > 0) {
    converted[converted.length - 1]!.cache_control = { type: "ephemeral" };
  }

  return converted;
}

function convertMessages(messages: ChatMessage[]): AnthropicMessage[] {
  const raw: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") continue;

    if (msg.role === "user") {
      if (Array.isArray(msg.content)) {
        // Multimodal content — convert to Anthropic format
        const blocks: AnthropicContentBlock[] = msg.content.map((p) => {
          if (p.type === "text") return { type: "text" as const, text: p.text };
          return { type: "image" as const, source: { type: "url" as const, url: p.image_url.url } };
        });
        raw.push({ role: "user", content: blocks });
      } else {
        raw.push({ role: "user", content: msg.content ?? "" });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const textContent = contentAsString(msg.content);
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const blocks: AnthropicContentBlock[] = [];

        if (textContent) {
          blocks.push({ type: "text", text: textContent });
        }

        for (const tc of msg.tool_calls) {
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments),
          });
        }

        raw.push({ role: "assistant", content: blocks });
      } else {
        raw.push({ role: "assistant", content: textContent });
      }
      continue;
    }

    if (msg.role === "tool") {
      raw.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.tool_call_id!,
            content: contentAsString(msg.content) || undefined,
          },
        ],
      });
      continue;
    }
  }

  // Merge consecutive same-role messages (Anthropic requires alternating)
  const merged: AnthropicMessage[] = [];
  for (const msg of raw) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role) {
      // Normalize both to arrays and concatenate
      const prevBlocks = toBlockArray(prev.content);
      const curBlocks = toBlockArray(msg.content);
      prev.content = [...prevBlocks, ...curBlocks];
    } else {
      merged.push(msg);
    }
  }

  // Cache breakpoint 3: mark the second-to-last user message's last content
  // block as ephemeral. This caches the entire conversation prefix up to that
  // point, reducing cost on long multi-turn conversations.
  const userIndices = merged
    .map((m, i) => ({ role: m.role, i }))
    .filter((x) => x.role === "user")
    .map((x) => x.i);

  if (userIndices.length >= 2) {
    const targetIdx = userIndices[userIndices.length - 2]!;
    const target = merged[targetIdx]!;
    if (typeof target.content === "string") {
      target.content = [
        { type: "text", text: target.content, cache_control: { type: "ephemeral" } },
      ];
    } else {
      const lastBlock = target.content[target.content.length - 1];
      if (lastBlock) {
        (lastBlock as { cache_control?: { type: "ephemeral" } }).cache_control = {
          type: "ephemeral",
        };
      }
    }
  }

  return merged;
}

function toBlockArray(
  content: string | AnthropicContentBlock[],
): AnthropicContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return content;
}

// ── Stop Reason Mapping ─────────────────────────────────────────────

function mapFinishReason(
  stopReason: string | null,
): InferenceResponse["finishReason"] {
  switch (stopReason) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    default:
      return "stop";
  }
}

// ── Client Factory ──────────────────────────────────────────────────

export function createClaudeClient(
  apiKey: string,
  modelId: string,
): InferenceClient {
  const client = new Anthropic({ apiKey });

  return {
    async chat(request: InferenceRequest): Promise<InferenceResponse> {
      const system = extractSystemBlocks(request.messages);
      const messages = convertMessages(request.messages);
      const tools = request.tools ? convertTools(request.tools) : undefined;

      const response = await client.messages.create({
        model: modelId,
        system: system.length > 0 ? system : undefined,
        messages: messages as Anthropic.Messages.MessageParam[],
        tools: tools as Anthropic.Messages.Tool[] | undefined,
        temperature: request.temperature ?? 0.7,
        max_tokens: request.maxTokens ?? 4096,
      });

      // Extract text content
      const textBlocks = response.content.filter(
        (b): b is Anthropic.Messages.TextBlock => b.type === "text",
      );
      const content = textBlocks.length > 0
        ? textBlocks.map((b) => b.text).join("")
        : null;

      // Extract tool calls
      const toolCalls = response.content
        .filter(
          (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
        )
        .map((b) => ({
          id: b.id,
          name: b.name,
          arguments: JSON.stringify(b.input),
        }));

      const usage: InferenceResponse["usage"] = {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
        cachedTokens: (response.usage as unknown as Record<string, number>).cache_read_input_tokens ?? undefined,
        cacheCreationTokens: (response.usage as unknown as Record<string, number>).cache_creation_input_tokens ?? undefined,
      };

      logCacheMetrics("claude", usage);

      return {
        content,
        toolCalls,
        usage,
        finishReason: mapFinishReason(response.stop_reason),
      };
    },

    async *chatStream(
      request: InferenceRequest,
    ): AsyncIterable<InferenceStreamDelta> {
      const system = extractSystemBlocks(request.messages);
      const messages = convertMessages(request.messages);
      const tools = request.tools ? convertTools(request.tools) : undefined;

      const stream = client.messages.stream({
        model: modelId,
        system: system.length > 0 ? system : undefined,
        messages: messages as Anthropic.Messages.MessageParam[],
        tools: tools as Anthropic.Messages.Tool[] | undefined,
        temperature: request.temperature ?? 0.7,
        max_tokens: request.maxTokens ?? 4096,
      });

      // Track tool call indices by block index
      let toolBlockIndex = 0;

      for await (const event of stream) {
        if (event.type === "content_block_start") {
          const block = event.content_block;
          if (block.type === "tool_use") {
            yield {
              type: "tool_call",
              toolCall: {
                index: toolBlockIndex++,
                id: block.id,
                name: block.name,
              },
            };
          }
          continue;
        }

        if (event.type === "content_block_delta") {
          const delta = event.delta;
          if (delta.type === "text_delta") {
            yield { type: "content", content: delta.text };
          } else if (delta.type === "input_json_delta") {
            yield {
              type: "tool_call",
              toolCall: {
                index: toolBlockIndex - 1,
                arguments: delta.partial_json,
              },
            };
          }
          continue;
        }

        if (event.type === "message_delta") {
          const finalMessage = await stream.finalMessage();
          const rawUsage = finalMessage.usage as unknown as Record<string, number>;
          const usage: InferenceResponse["usage"] = {
            promptTokens: finalMessage.usage.input_tokens,
            completionTokens: finalMessage.usage.output_tokens,
            totalTokens:
              finalMessage.usage.input_tokens +
              finalMessage.usage.output_tokens,
            cachedTokens: rawUsage.cache_read_input_tokens ?? undefined,
            cacheCreationTokens: rawUsage.cache_creation_input_tokens ?? undefined,
          };

          logCacheMetrics("claude", usage);

          yield { type: "done", usage };
          continue;
        }
      }
    },
  };
}
