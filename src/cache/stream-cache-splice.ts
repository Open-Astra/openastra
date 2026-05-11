// ── Response Streaming with Early Cache Hits (Feature 5) ─────────────
// Checks for full cache hits while streaming a response.
// If a cache hit is found during streaming, splice in the cached response.
// Otherwise, continue with the original stream.

import { createHash } from "node:crypto";
import { createLogger } from "../utils/logger.js";

const log = createLogger("stream-cache-splice");

export interface StreamChunk {
  type: "stream" | "cache" | "header" | "end";
  data?: string; // For stream/cache chunks
  cacheHit?: boolean;
  elapsedMs?: number;
}

/**
 * Checks cache while streaming a response.
 * Yields cached data if found, otherwise continues with live stream.
 * @param sessionId - Session identifier
 * @param requestHash - Hash of the original request
 * @param cacheChecker - Async function that checks if full response is cached
 * @param liveStream - AsyncGenerator of live response chunks
 * @returns AsyncGenerator of StreamChunk objects
 */
export async function* checkCacheWhileStreaming(
  _sessionId: string,
  _requestHash: string,
  cacheChecker: () => Promise<string | null>,
  liveStream: AsyncGenerator<string>,
): AsyncGenerator<StreamChunk> {
  const startTime = Date.now();
  let cacheChecked = false;
  let cacheMissed = false;

  try {
    // Start checking cache in background while streaming begins
    const cacheCheckPromise = (async () => {
      try {
        return await cacheChecker();
      } catch (err) {
        log.dim(`Cache check failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    })();

    // Stream from live source while cache check is in progress
    let streamBuffer: string[] = [];
    const streamIterator = liveStream[Symbol.asyncIterator]();

    while (true) {
      // Check if cache is ready (non-blocking)
      let cachedResponse: string | null = null;
      try {
        const cachePromise = Promise.race([
          cacheCheckPromise,
          new Promise<null>(resolve => setTimeout(() => resolve(null), 50)), // 50ms timeout
        ]);
        cachedResponse = await cachePromise;
      } catch (err) {
        // Ignore race errors
      }

      // If cache hit found, splice it in
      if (cachedResponse && !cacheMissed && !cacheChecked) {
        cacheChecked = true;
        const elapsedMs = Date.now() - startTime;

        // Yield remaining stream buffer (partial response)
        if (streamBuffer.length > 0) {
          for (const chunk of streamBuffer) {
            yield { type: "stream", data: chunk };
          }
        }

        // Splice in cached response
        log.info(`Cache hit during streaming (${elapsedMs}ms elapsed)`);
        yield {
          type: "cache",
          data: cachedResponse,
          cacheHit: true,
          elapsedMs,
        };
        yield { type: "end" };
        return;
      }

      // Get next chunk from live stream (non-blocking)
      try {
        const streamPromise = Promise.race([
          streamIterator.next(),
          new Promise<IteratorResult<string>>(resolve =>
            setTimeout(() => resolve({ done: false, value: "" }), 50),
          ),
        ]);
        const result = await streamPromise;

        if (result.done) {
          cacheChecked = true;
          cacheMissed = true;

          // Stream completed without cache hit
          for (const chunk of streamBuffer) {
            yield { type: "stream", data: chunk };
          }
          yield { type: "end" };
          return;
        }

        if (result.value) {
          streamBuffer.push(result.value);
          yield { type: "stream", data: result.value };
        }
      } catch (err) {
        log.warn(`Stream error: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }

      // After streaming 5 chunks, mark cache as missed
      if (streamBuffer.length >= 5 && !cacheChecked) {
        cacheChecked = true;
        cacheMissed = true;
      }
    }
  } catch (err) {
    log.warn(`Stream cache splice error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    yield { type: "end" };
  }
}

/**
 * Compute a stable hash for a request (for cache lookup).
 * @param sessionId - Session ID
 * @param agentId - Agent ID
 * @param messageHash - Hash of message content
 * @returns Request hash for cache lookups
 */
export function computeStreamCacheKey(sessionId: string, agentId: string, messageHash: string): string {
  const payload = JSON.stringify({ sessionId, agentId, messageHash });
  return createHash("sha256").update(payload).digest("hex");
}
