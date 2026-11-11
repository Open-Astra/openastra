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
// a secondary provider. Retries transient errors (429, 5xx, network)
// with exponential backoff before falling through to the fallback.
// A per-provider circuit breaker fast-fails when a provider is down
// and bypasses retries to go directly to the fallback. Only errors that
// reflect provider health trip the breaker — a caller's 400/401 does not.

interface ResilientOptions {
  primary: InferenceClient;
  fallback?: InferenceClient;
  maxRetries?: number;
  baseDelayMs?: number;
  /** Circuit-breaker key. Must identify the provider (and endpoint). */
  label?: string;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 529]);

const RETRYABLE_PATTERNS: RegExp[] = [
  /\b(408|429|500|502|503|504|529)\b/,
  /rate limit/i,
  /overloaded/i,
  /econnreset|econnrefused|etimedout|enotfound|eai_again|epipe/i,
  /fetch failed/i,
  /network/i,
  /socket hang up/i,
];

function errorStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  const candidate = e.status ?? e.statusCode ?? e.response?.status;
  return typeof candidate === "number" ? candidate : undefined;
}

/**
 * True when the error is transient / reflects provider health (rate limit,
 * 5xx, timeout, network). False for caller-side errors (400, 401, 403, 404,
 * context-too-long …) which must neither be retried nor trip the breaker.
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof InferenceTimeoutError) return true;
  const status = errorStatus(err);
  if (status !== undefined) return RETRYABLE_STATUS.has(status);
  const msg = err instanceof Error ? err.message : String(err);
  return RETRYABLE_PATTERNS.some((p) => p.test(msg));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_TIMEOUT_MS = 60_000;

function isCircuitOpenError(err: unknown): boolean {
  return err instanceof Error &&
    err.message.includes("circuit-breaker") &&
    err.message.includes("OPEN");
}

/** Link an optional caller signal to a controller we own. */
function linkSignal(parent: AbortSignal | undefined, controller: AbortController): void {
  if (!parent) return;
  if (parent.aborted) {
    controller.abort(parent.reason);
    return;
  }
  parent.addEventListener("abort", () => controller.abort(parent.reason), { once: true });
}

/**
 * Run a chat call with a hard wall-clock timeout. On timeout the underlying
 * request is aborted (so it stops running and billing) and
 * InferenceTimeoutError is thrown.
 */
async function chatWithTimeout(
  client: InferenceClient,
  request: InferenceRequest,
  providerLabel: string,
  timeoutMs: number,
): Promise<InferenceResponse> {
  const controller = new AbortController();
  linkSignal(request.signal, controller);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new InferenceTimeoutError(providerLabel, timeoutMs);
      controller.abort(err);
      reject(err);
    }, timeoutMs);
  });

  const call = client.chat({ ...request, signal: controller.signal });
  // If the timeout wins, the aborted call rejects later — swallow that.
  call.catch(() => {});

  try {
    return await Promise.race([call, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
        return await chatWithTimeout(client, request, retryLabel, timeoutMs);
      } catch (err) {
        lastError = err;
        const retryable = isRetryable(err);
        console.error(
          `[resilient] ${retryLabel} attempt ${attempt + 1}/${maxRetries + 1} failed:`,
          err instanceof Error ? err.message : err,
          retryable ? "(retryable)" : "(non-retryable)",
        );

        if (!retryable || attempt === maxRetries) break;
        if (request.signal?.aborted) break;

        const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 500;
        await sleep(delay);
      }
    }

    throw lastError;
  }

  async function chatPrimaryWithBreaker(request: InferenceRequest): Promise<InferenceResponse> {
    return cb.execute(() => chatWithRetry(primary, request, label), isRetryable);
  }

  /**
   * Iterate a provider stream with an idle timeout: if no delta arrives within
   * timeoutMs (first token or between tokens) the request is aborted.
   */
  async function* streamWithIdleTimeout(
    request: InferenceRequest,
  ): AsyncGenerator<InferenceStreamDelta> {
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    linkSignal(request.signal, controller);

    const iterator = primary
      .chatStream({ ...request, signal: controller.signal })[Symbol.asyncIterator]();

    try {
      while (true) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const err = new InferenceTimeoutError(label, timeoutMs);
            controller.abort(err);
            reject(err);
          }, timeoutMs);
        });

        const next = iterator.next();
        next.catch(() => {});
        let result: IteratorResult<InferenceStreamDelta>;
        try {
          result = await Promise.race([next, timeout]);
        } finally {
          if (timer) clearTimeout(timer);
        }

        if (result.done) return;
        yield result.value;
      }
    } finally {
      // Consumer stopped early or we errored — release the provider stream.
      if (!controller.signal.aborted) controller.abort();
      void iterator.return?.().catch(() => {});
    }
  }

  return {
    async chat(request: InferenceRequest): Promise<InferenceResponse> {
      try {
        return await chatPrimaryWithBreaker(request);
      } catch (primaryErr) {
        if (!fallback) throw primaryErr;

        const circuitOpen = isCircuitOpenError(primaryErr);
        // Caller-side errors (bad request, auth, too long) would fail on the
        // fallback as well, and must not leak the prompt to another provider.
        if (!circuitOpen && !isRetryable(primaryErr)) throw primaryErr;

        if (circuitOpen) {
          console.warn(`[resilient] Circuit open for "${label}", skipping retries → fallback`);
        } else {
          console.warn("[resilient] Primary exhausted, falling back to secondary provider");
        }

        try {
          return await chatWithRetry(fallback, request, "fallback");
        } catch (fallbackErr) {
          // Both failed — throw the primary error (more relevant)
          console.error(
            "[resilient] Fallback also failed:",
            fallbackErr instanceof Error ? fallbackErr.message : fallbackErr,
          );
          throw primaryErr;
        }
      }
    },

    async *chatStream(
      request: InferenceRequest,
    ): AsyncIterable<InferenceStreamDelta> {
      // Streaming uses primary only. A fallback (non-streaming) response is
      // used only when the primary failed BEFORE emitting anything — once
      // deltas have reached the caller, emitting a second full response
      // would duplicate output, so the error is surfaced instead.
      let emitted = false;
      const start = Date.now();
      let acquired = false;
      let settled = false;

      try {
        cb.acquire(); // throws when OPEN; moves OPEN → HALF-OPEN after cool-down
        acquired = true;

        for await (const delta of streamWithIdleTimeout(request)) {
          emitted = true;
          yield delta;
        }
        settled = true;
        cb.recordSuccess(Date.now() - start);
      } catch (err) {
        if (acquired && !settled) {
          settled = true;
          if (isRetryable(err)) cb.recordFailure(Date.now() - start);
          else cb.recordSuccess(Date.now() - start);
        }

        if (!fallback || emitted) throw err;
        if (!isCircuitOpenError(err) && !isRetryable(err)) throw err;

        console.warn("[resilient] Stream failed before first token, falling back to non-streaming");
        const response = await chatWithRetry(fallback, request, "fallback-stream");

        if (response.content) {
          yield { type: "content", content: response.content };
        }
        yield { type: "done", usage: response.usage };
      } finally {
        // Consumer abandoned the stream mid-way: the provider was healthy.
        if (acquired && !settled) cb.recordSuccess(Date.now() - start);
      }
    },
  };
}
