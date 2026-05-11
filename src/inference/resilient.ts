import type {
  InferenceClient,
  InferenceRequest,
  InferenceResponse,
  InferenceStreamDelta,
} from "./types.js";
import { InferenceTimeoutError } from "./types.js";
import { getCircuitBreaker } from "./circuit-breaker.js";

// ── Resilient Inference Client ──────────────────────────────────────
// Wraps an InferenceClient with retry logic and optional fallback to
// a secondary provider. Retries transient errors (429, 500, 502, 503)
// with exponential backoff before falling through to the fallback.
// A per-provider circuit breaker fast-fails when a provider is down
// and bypasses retries to go directly to the fallback.

interface ResilientOptions {
  primary: InferenceClient;
  fallback?: InferenceClient;
  maxRetries?: number;
  baseDelayMs?: number;
  label?: string;
}

const RETRYABLE_PATTERNS = [
  "429", "rate limit",
  "500", "502", "503", "504",
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT",
  "fetch failed", "network",
];

function isRetryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return RETRYABLE_PATTERNS.some((p) => msg.includes(p));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Wrap a chat call with a hard wall-clock timeout.
 * Throws InferenceTimeoutError if the provider does not resolve in time.
 */
function withTimeout(
  call: Promise<InferenceResponse>,
  providerLabel: string,
  timeoutMs: number,
): Promise<InferenceResponse> {
  return new Promise<InferenceResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new InferenceTimeoutError(providerLabel, timeoutMs));
    }, timeoutMs);

    call.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function createResilientClient(options: ResilientOptions): InferenceClient {
  const { primary, fallback, maxRetries = 2, baseDelayMs = 1000, label = "primary" } = options;
  const cb = getCircuitBreaker(label);

  async function chatWithRetry(
    client: InferenceClient,
    request: InferenceRequest,
    retryLabel: string,
  ): Promise<InferenceResponse> {
    let lastError: unknown;
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await withTimeout(client.chat(request), retryLabel, timeoutMs);
      } catch (err) {
        lastError = err;
        const retryable = isRetryable(err);
        console.error(
          `[resilient] ${retryLabel} attempt ${attempt + 1}/${maxRetries + 1} failed:`,
          err instanceof Error ? err.message : err,
          retryable ? "(retryable)" : "(non-retryable)",
        );

        if (!retryable || attempt === maxRetries) break;

        const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 500;
        await sleep(delay);
      }
    }

    throw lastError;
  }

  async function chatPrimaryWithBreaker(request: InferenceRequest): Promise<InferenceResponse> {
    return cb.execute(() => chatWithRetry(primary, request, label));
  }

  return {
    async chat(request: InferenceRequest): Promise<InferenceResponse> {
      try {
        return await chatPrimaryWithBreaker(request);
      } catch (primaryErr) {
        // If circuit is open (fast-fail) or retries exhausted, go to fallback
        if (!fallback) throw primaryErr;

        const isCircuitOpen = primaryErr instanceof Error &&
          primaryErr.message.includes("circuit-breaker") &&
          primaryErr.message.includes("OPEN");

        if (isCircuitOpen) {
          console.warn(`[resilient] Circuit open for "${label}", skipping retries → fallback`);
        } else {
          console.warn("[resilient] Primary exhausted, falling back to secondary provider");
        }

        try {
          return await chatWithRetry(fallback, request, "fallback");
        } catch (fallbackErr) {
          // Both failed — throw the primary error (more relevant)
          console.error("[resilient] Fallback also failed:", fallbackErr);
          throw primaryErr;
        }
      }
    },

    async *chatStream(
      request: InferenceRequest,
    ): AsyncIterable<InferenceStreamDelta> {
      // Streaming uses primary only (no mid-stream failover).
      // If primary fails (or circuit is open), fall back for a non-streaming response.
      try {
        if (cb.isOpen) {
          throw new Error(`[circuit-breaker] ${label} is OPEN — fast failing`);
        }
        yield* primary.chatStream(request);
      } catch (err) {
        if (!fallback) throw err;

        console.warn("[resilient] Stream failed, falling back to non-streaming");
        const response = await chatWithRetry(fallback, request, "fallback-stream");

        // Emit the full response as a single content delta + done
        if (response.content) {
          yield { type: "content", content: response.content };
        }
        yield { type: "done", usage: response.usage };
      }
    },
  };
}
