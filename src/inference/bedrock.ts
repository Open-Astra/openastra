// ── AWS Bedrock Provider ─────────────────────────────────────────────
// Uses the Bedrock Converse API — a unified interface for all Bedrock
// models (Claude, Llama, Mistral, Titan, etc.) introduced in 2024.
//
// Env vars:
//   AWS_ACCESS_KEY_ID      — AWS access key (or use instance role)
//   AWS_SECRET_ACCESS_KEY  — AWS secret key (or use instance role)
//   AWS_REGION             — AWS region (default: us-east-1)
//
// Model IDs (examples):
//   anthropic.claude-3-5-sonnet-20241022-v2:0
//   meta.llama3-8b-instruct-v1:0
//   mistral.mistral-large-2402-v1:0

import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type Message,
  type SystemContentBlock,
  type Tool,
  type ToolResultContentBlock,
} from "@aws-sdk/client-bedrock-runtime";
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

// ── Type Helpers ──────────────────────────────────────────────────────

function extractSystem(messages: ChatMessage[]): SystemContentBlock[] {
  return messages
    .filter((m) => m.role === "system" && m.content)
    .map((m) => ({ text: contentAsString(m.content) }));
}

function convertTools(tools: ToolSchema[]): Tool[] {
  return tools.map((t) => ({
    toolSpec: {
      name: t.function.name,
      description: t.function.description,
      inputSchema: { json: t.function.parameters as never },
    },
  })) as Tool[];
}

function convertMessages(messages: ChatMessage[]): Message[] {
  const raw: Message[] = [];

  for (const msg of messages) {
    if (msg.role === "system") continue;

    if (msg.role === "user") {
      raw.push({ role: "user", content: [{ text: contentAsString(msg.content) }] });
      continue;
    }

    if (msg.role === "assistant") {
      const textContent = contentAsString(msg.content);
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // Build blocks as plain records to avoid ContentBlock union strictness
        const blocks: Array<Record<string, unknown>> = [];
        if (textContent) blocks.push({ text: textContent });
        for (const tc of msg.tool_calls) {
          blocks.push({
            toolUse: {
              toolUseId: tc.id,
              name: tc.function.name,
              input: JSON.parse(tc.function.arguments) as unknown,
            },
          });
        }
        raw.push({ role: "assistant", content: blocks as unknown as Message["content"] });
      } else {
        raw.push({ role: "assistant", content: [{ text: textContent }] });
      }
      continue;
    }

    if (msg.role === "tool") {
      const resultBlock: ToolResultContentBlock = { text: contentAsString(msg.content) };
      raw.push({
        role: "user",
        content: [{
          toolResult: {
            toolUseId: msg.tool_call_id!,
            content: [resultBlock],
            status: "success",
          },
        }],
      });
      continue;
    }
  }

  // Merge consecutive same-role messages (Bedrock requires alternating)
  const merged: Message[] = [];
  for (const msg of raw) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role) {
      prev.content = [...(prev.content ?? []), ...(msg.content ?? [])];
    } else {
      merged.push(msg);
    }
  }

  return merged;
}

function mapStopReason(stopReason: string | undefined): InferenceResponse["finishReason"] {
  if (stopReason === "tool_use") return "tool_calls";
  if (stopReason === "max_tokens") return "length";
  return "stop";
}

// ── Client Factory ────────────────────────────────────────────────────

export function createBedrockClient(
  region: string,
  modelId: string,
  credentials?: { accessKeyId: string; secretAccessKey: string },
): InferenceClient {
  const client = new BedrockRuntimeClient({
    region,
    ...(credentials ? { credentials } : {}),
  });

  return {
    async chat(request: InferenceRequest): Promise<InferenceResponse> {
      const system = extractSystem(request.messages);
      const messages = convertMessages(request.messages);
      const tools = request.tools?.length ? convertTools(request.tools) : undefined;

      const command = new ConverseCommand({
        modelId,
        messages,
        system: system.length > 0 ? system : undefined,
        toolConfig: tools ? { tools } : undefined,
        inferenceConfig: {
          temperature: request.temperature ?? 0.7,
          maxTokens: request.maxTokens ?? 4096,
        },
      });

      const response = await client.send(command);
      // Cast to plain records to bypass ContentBlock discriminated-union narrowing
      const outputContent = (response.output?.message?.content ?? []) as unknown as Array<Record<string, unknown>>;

      const textParts: string[] = [];
      const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];

      for (const block of outputContent) {
        if (typeof block.text === "string") {
          textParts.push(block.text);
        }
        if (block.toolUse && typeof block.toolUse === "object") {
          const tu = block.toolUse as { toolUseId?: string; name?: string; input?: unknown };
          toolCalls.push({
            id: tu.toolUseId ?? "",
            name: tu.name ?? "",
            arguments: JSON.stringify(tu.input ?? {}),
          });
        }
      }

      const content = textParts.length > 0 ? textParts.join("") : null;

      const usage: InferenceResponse["usage"] = {
        promptTokens: response.usage?.inputTokens ?? 0,
        completionTokens: response.usage?.outputTokens ?? 0,
        totalTokens: (response.usage?.inputTokens ?? 0) + (response.usage?.outputTokens ?? 0),
      };

      logCacheMetrics("bedrock", usage);

      return { content, toolCalls, usage, finishReason: mapStopReason(response.stopReason) };
    },

    async *chatStream(request: InferenceRequest): AsyncIterable<InferenceStreamDelta> {
      const system = extractSystem(request.messages);
      const messages = convertMessages(request.messages);
      const tools = request.tools?.length ? convertTools(request.tools) : undefined;

      const command = new ConverseStreamCommand({
        modelId,
        messages,
        system: system.length > 0 ? system : undefined,
        toolConfig: tools ? { tools } : undefined,
        inferenceConfig: {
          temperature: request.temperature ?? 0.7,
          maxTokens: request.maxTokens ?? 4096,
        },
      });

      const response = await client.send(command);
      let toolBlockIndex = 0;

      for await (const event of response.stream ?? []) {
        if (event.contentBlockStart?.start?.toolUse) {
          const tu = event.contentBlockStart.start.toolUse;
          yield {
            type: "tool_call",
            toolCall: { index: toolBlockIndex++, id: tu.toolUseId, name: tu.name },
          };
          continue;
        }

        if (event.contentBlockDelta?.delta) {
          const delta = event.contentBlockDelta.delta as unknown as Record<string, unknown>;
          if (typeof delta.text === "string") {
            yield { type: "content", content: delta.text };
          } else if (delta.toolUse && typeof delta.toolUse === "object") {
            const tu = delta.toolUse as { input?: string };
            if (typeof tu.input === "string") {
              yield {
                type: "tool_call",
                toolCall: { index: toolBlockIndex - 1, arguments: tu.input },
              };
            }
          }
          continue;
        }

        if (event.metadata?.usage) {
          const u = event.metadata.usage;
          const usage: InferenceResponse["usage"] = {
            promptTokens: u.inputTokens ?? 0,
            completionTokens: u.outputTokens ?? 0,
            totalTokens: (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
          };
          logCacheMetrics("bedrock", usage);
          yield { type: "done", usage };
        }
      }
    },
  };
}
