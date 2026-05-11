import type {
  InferenceClient,
  InferenceRequest,
  InferenceResponse,
  InferenceStreamDelta,
} from "./types.js";
import { getStaleSemanticCache, setSemanticCache } from "../cache/semantic.js";
import { createLogger } from "../utils/logger.js";

// ── Semantic Cache Layer ───────────────────────────────────────────
// Wraps an InferenceClient to check/populate the semantic cache for
// non-streaming chat() calls. Streaming is passed through unchanged.
//
// Uses stale-while-revalidate (SWR): entries older than SWR_MAX_AGE_MS/2
// are served immediately while a background refresh updates the cache.

const log = createLogger("semantic-cache-layer");

// Entries older than half this value trigger a background refresh while
// the stale entry is still returned immediately to the caller.
const SWR_MAX_AGE_MS = 5 * 60_000; // 5 minutes

/**
 * Extract the last user message text from the request messages.
 * Used as the cache key for semantic matching.
 */
function extractQueryText(request: InferenceRequest): string | null {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const msg = request.messages[i];
    if (msg.role === "user" && msg.content) {
      return typeof msg.content === "string" ? msg.content : null;
    }
  }
  return null;
}

export function withSemanticCache(
  client: InferenceClient,
  agentId: string,
): InferenceClient {
  return {
    async chat(request: InferenceRequest): Promise<InferenceResponse> {
      // Only cache when there are no tool schemas (tool calls change behavior)
      const queryText = extractQueryText(request);
      if (queryText && (!request.tools || request.tools.length === 0)) {
        try {
          const swrResult = await getStaleSemanticCache(queryText, agentId, SWR_MAX_AGE_MS);
          if (swrResult) {
            const cachedResponse: InferenceResponse = {
              content: swrResult.content,
              toolCalls: [],
              usage: {
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: 0,
                cachedTokens: 0,
              },
              finishReason: "stop",
            };

            if (!swrResult.isStale) {
              log.dim(`Cache hit (fresh) for agent ${agentId}`);
              return cachedResponse;
            }

            // Stale hit: return immediately and refresh in the background
            log.dim(`Cache hit (stale) for agent ${agentId} — revalidating in background`);
            (async () => {
              try {
                const fresh = await client.chat(request);
                if (fresh.content && fresh.toolCalls.length === 0) {
                  await setSemanticCache(queryText, fresh.content, agentId);
                }
              } catch {
                // Background refresh failure is non-fatal
              }
            })().catch(() => {});
            return cachedResponse;
          }
        } catch {
          // Cache errors are non-fatal
        }
      }

      const response = await client.chat(request);

      // Cache successful responses with content and no tool calls
      if (
        queryText &&
        response.content &&
        response.toolCalls.length === 0 &&
        (!request.tools || request.tools.length === 0)
      ) {
        setSemanticCache(queryText, response.content, agentId).catch(() => {});
      }

      return response;
    },

    chatStream(
      request: InferenceRequest,
    ): AsyncIterable<InferenceStreamDelta> {
      // Don't cache streaming responses — pass through directly
      return client.chatStream(request);
    },
  };
}
