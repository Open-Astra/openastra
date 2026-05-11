import OpenAI from "openai";
import type {
  InferenceClient,
  InferenceRequest,
  InferenceResponse,
  InferenceStreamDelta,
} from "./types.js";
import { logCacheMetrics } from "./cache-metrics.js";

export function createOpenAIClient(
  apiKey: string,
  modelId: string,
  baseURL = "https://api.openai.com/v1",
  defaultHeaders?: Record<string, string>,
): InferenceClient {
  const client = new OpenAI({ apiKey, baseURL, defaultHeaders });

  return {
    async chat(request: InferenceRequest): Promise<InferenceResponse> {
      const response = await client.chat.completions.create({
        model: modelId,
        messages: request.messages as OpenAI.ChatCompletionMessageParam[],
        tools: request.tools as OpenAI.ChatCompletionTool[] | undefined,
        temperature: request.temperature ?? 0.7,
        max_tokens: request.maxTokens,
        stream: false,
      });

      const choice = response.choices[0]!;
      const cached =
        (response.usage as Record<string, unknown> | undefined)?.prompt_tokens_details as
          | Record<string, unknown>
          | undefined;

      const usage: InferenceResponse["usage"] = {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
        cachedTokens: (cached?.cached_tokens as number | undefined) ?? 0,
      };

      logCacheMetrics("openai", usage);

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
      const stream = await client.chat.completions.create({
        model: modelId,
        messages: request.messages as OpenAI.ChatCompletionMessageParam[],
        tools: request.tools as OpenAI.ChatCompletionTool[] | undefined,
        temperature: request.temperature ?? 0.7,
        max_tokens: request.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
      });

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;

        if (!delta && chunk.usage) {
          const cached =
            (chunk.usage as unknown as Record<string, unknown>).prompt_tokens_details as
              | Record<string, unknown>
              | undefined;

          const usage: InferenceResponse["usage"] = {
            promptTokens: chunk.usage.prompt_tokens ?? 0,
            completionTokens: chunk.usage.completion_tokens ?? 0,
            totalTokens: chunk.usage.total_tokens ?? 0,
            cachedTokens: (cached?.cached_tokens as number | undefined) ?? 0,
          };

          logCacheMetrics("openai", usage);

          yield { type: "done", usage };
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
