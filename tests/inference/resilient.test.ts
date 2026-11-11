import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// ── Hoisted shared mock objects ───────────────────────────────────────
const { mockCB } = vi.hoisted(() => {
  const cb = {
    execute: vi.fn(),
    acquire: vi.fn(),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
    isOpen: false,
  };
  return { mockCB: cb };
});

vi.mock("../../src/inference/circuit-breaker.js", () => ({
  getCircuitBreaker: vi.fn().mockReturnValue(mockCB),
}));

import { createResilientClient } from "../../src/inference/resilient.js";
import type { InferenceClient, InferenceRequest, InferenceResponse } from "../../src/inference/types.js";

// ── Helpers ───────────────────────────────────────────────────────────

const sampleRequest: InferenceRequest = {
  messages: [{ role: "user", content: "hello" }],
};

function makeResponse(content: string): InferenceResponse {
  return {
    content,
    toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    finishReason: "stop",
  };
}

function makeClient(chatImpl: () => Promise<InferenceResponse>): InferenceClient {
  return {
    chat: vi.fn().mockImplementation(chatImpl),
    async *chatStream() { yield { type: "done" as const, usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } }; },
  };
}

describe("createResilientClient — chat()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockCB.isOpen = false;
    // Default: circuit breaker passes through by executing fn directly
    mockCB.execute.mockImplementation((fn: () => Promise<unknown>) => fn());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("successful primary call passes through unchanged", async () => {
    const primary = makeClient(() => Promise.resolve(makeResponse("primary ok")));
    const client = createResilientClient({ primary, maxRetries: 0, baseDelayMs: 0 });

    const result = await client.chat(sampleRequest);
    expect(result.content).toBe("primary ok");
    expect(primary.chat).toHaveBeenCalledOnce();
  });

  it("retries on transient errors (429 rate limit) up to maxRetries", async () => {
    let attempts = 0;
    const primary = makeClient(() => {
      attempts++;
      if (attempts <= 2) return Promise.reject(new Error("429 rate limit exceeded"));
      return Promise.resolve(makeResponse("success after retries"));
    });

    const client = createResilientClient({ primary, maxRetries: 2, baseDelayMs: 0 });
    // Advance fake timers to skip sleep delays
    const chatPromise = client.chat(sampleRequest);
    await vi.runAllTimersAsync();
    const result = await chatPromise;

    expect(result.content).toBe("success after retries");
    expect(primary.chat).toHaveBeenCalledTimes(3);
  });

  it("non-retryable error fails immediately without additional retries", async () => {
    let callCount = 0;
    const primary = makeClient(() => {
      callCount++;
      return Promise.reject(new Error("Authentication failed"));
    });

    const client = createResilientClient({ primary, maxRetries: 2, baseDelayMs: 0 });
    await expect(client.chat(sampleRequest)).rejects.toThrow("Authentication failed");
    // Should only be called once (no retries for non-retryable errors)
    expect(primary.chat).toHaveBeenCalledTimes(1);
  });

  it("uses fallback provider when primary exhausts all retries", async () => {
    const primary = makeClient(() => Promise.reject(new Error("500 internal server error")));
    const fallback = makeClient(() => Promise.resolve(makeResponse("fallback response")));

    const client = createResilientClient({ primary, fallback, maxRetries: 0, baseDelayMs: 0 });
    const result = await client.chat(sampleRequest);

    expect(result.content).toBe("fallback response");
    expect(primary.chat).toHaveBeenCalled();
    expect(fallback.chat).toHaveBeenCalled();
  });

  it("throws primary error when both primary and fallback fail", async () => {
    const primary = makeClient(() => Promise.reject(new Error("500 primary error")));
    const fallback = makeClient(() => Promise.reject(new Error("fallback also failed")));

    const client = createResilientClient({ primary, fallback, maxRetries: 0, baseDelayMs: 0 });
    // Should throw the primary error
    await expect(client.chat(sampleRequest)).rejects.toThrow("500 primary error");
  });

  it("circuit breaker open skips to fallback immediately", async () => {
    // Simulate circuit breaker throwing the OPEN error
    mockCB.execute.mockRejectedValue(new Error("[circuit-breaker] primary is OPEN — fast failing"));

    const fallback = makeClient(() => Promise.resolve(makeResponse("cb-fallback response")));
    const primary = makeClient(() => Promise.resolve(makeResponse("should not reach")));

    const client = createResilientClient({ primary, fallback, maxRetries: 2, baseDelayMs: 0, label: "primary" });
    const result = await client.chat(sampleRequest);

    expect(result.content).toBe("cb-fallback response");
    // Primary chat should not have been called directly (circuit breaker blocked it)
    expect(primary.chat).not.toHaveBeenCalled();
    expect(fallback.chat).toHaveBeenCalledOnce();
  });

  it("throws when no fallback and primary fails with a non-retryable error", async () => {
    const primary = makeClient(() => Promise.reject(new Error("fatal error no fallback")));
    const client = createResilientClient({ primary, maxRetries: 0, baseDelayMs: 0 });
    await expect(client.chat(sampleRequest)).rejects.toThrow("fatal error no fallback");
  });
});

describe("createResilientClient — chatStream()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockCB.isOpen = false;
    mockCB.acquire.mockReset();
    mockCB.execute.mockImplementation((fn: () => Promise<unknown>) => fn());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("yields stream deltas from primary when circuit is closed", async () => {
    const deltas = [
      { type: "content" as const, content: "hello" },
      { type: "done" as const, usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } },
    ];

    const primary: InferenceClient = {
      chat: vi.fn(),
      async *chatStream() {
        for (const d of deltas) yield d;
      },
    };

    const client = createResilientClient({ primary, maxRetries: 0, baseDelayMs: 0 });
    const collected = [];
    for await (const delta of client.chatStream(sampleRequest)) {
      collected.push(delta);
    }
    expect(collected).toHaveLength(2);
    expect(collected[0]).toMatchObject({ type: "content", content: "hello" });
  });

  it("falls back to non-streaming response when primary stream fails and circuit is open", async () => {
    mockCB.isOpen = true;
    mockCB.acquire.mockImplementation(() => {
      throw new Error("[circuit-breaker] primary is OPEN — fast failing");
    });

    const fallback = makeClient(() => Promise.resolve(makeResponse("fallback content")));
    const primary: InferenceClient = {
      chat: vi.fn(),
      async *chatStream() { throw new Error("stream failed"); },
    };

    const client = createResilientClient({ primary, fallback, maxRetries: 0, baseDelayMs: 0 });
    const collected = [];
    for await (const delta of client.chatStream(sampleRequest)) {
      collected.push(delta);
    }

    // Should have content delta + done delta from fallback
    const contentDelta = collected.find((d) => d.type === "content");
    const doneDelta = collected.find((d) => d.type === "done");
    expect(contentDelta).toBeDefined();
    expect(contentDelta?.content).toBe("fallback content");
    expect(doneDelta).toBeDefined();
  });
});

describe("createResilientClient — hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockCB.isOpen = false;
    mockCB.acquire.mockReset();
    mockCB.execute.mockImplementation((fn: () => Promise<unknown>) => fn());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
    const out: unknown[] = [];
    for await (const d of stream) out.push(d);
    return out;
  }

  it("does not emit a duplicate fallback response after a mid-stream failure", async () => {
    const fallback = makeClient(() => Promise.resolve(makeResponse("full fallback answer")));
    const primary: InferenceClient = {
      chat: vi.fn(),
      async *chatStream() {
        yield { type: "content" as const, content: "partial " };
        throw new Error("503 upstream died");
      },
    };
    const client = createResilientClient({ primary, fallback, maxRetries: 0, baseDelayMs: 0 });

    const seen: unknown[] = [];
    await expect((async () => {
      for await (const d of client.chatStream(sampleRequest)) seen.push(d);
    })()).rejects.toThrow("503 upstream died");

    expect(seen).toEqual([{ type: "content", content: "partial " }]);
    expect(fallback.chat).not.toHaveBeenCalled();
    expect(mockCB.recordFailure).toHaveBeenCalledOnce();
  });

  it("records stream success on the breaker so half-open can close", async () => {
    const primary: InferenceClient = {
      chat: vi.fn(),
      async *chatStream() { yield { type: "content" as const, content: "ok" }; },
    };
    const client = createResilientClient({ primary, maxRetries: 0, baseDelayMs: 0 });
    await collect(client.chatStream(sampleRequest));
    expect(mockCB.acquire).toHaveBeenCalledOnce();
    expect(mockCB.recordSuccess).toHaveBeenCalledOnce();
    expect(mockCB.recordFailure).not.toHaveBeenCalled();
  });

  it("a caller-side stream error (400) does not count as a provider failure", async () => {
    const primary: InferenceClient = {
      chat: vi.fn(),
      async *chatStream() { throw Object.assign(new Error("bad request"), { status: 400 }); },
    };
    const client = createResilientClient({ primary, maxRetries: 0, baseDelayMs: 0 });
    await expect(collect(client.chatStream(sampleRequest))).rejects.toThrow("bad request");
    expect(mockCB.recordFailure).not.toHaveBeenCalled();
  });

  it("aborts the underlying request when the timeout fires", async () => {
    let seenSignal: AbortSignal | undefined;
    const primary: InferenceClient = {
      chat: vi.fn().mockImplementation((req: InferenceRequest) => {
        seenSignal = req.signal;
        return new Promise(() => {}); // never resolves
      }),
      async *chatStream() { /* unused */ },
    };
    const client = createResilientClient({ primary, maxRetries: 0, baseDelayMs: 0 });
    const p = client.chat({ ...sampleRequest, timeoutMs: 1000 });
    const assertion = expect(p).rejects.toThrow(/timeout/i);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    expect(seenSignal?.aborted).toBe(true);
  });

  it("times out a stalled stream and aborts it", async () => {
    let seenSignal: AbortSignal | undefined;
    const primary: InferenceClient = {
      chat: vi.fn(),
      chatStream(req: InferenceRequest) {
        seenSignal = req.signal;
        return {
          [Symbol.asyncIterator]() {
            return { next: () => new Promise<IteratorResult<never>>(() => {}) };
          },
        };
      },
    };
    const client = createResilientClient({ primary, maxRetries: 0, baseDelayMs: 0 });
    const p = collect(client.chatStream({ ...sampleRequest, timeoutMs: 500 }));
    const assertion = expect(p).rejects.toThrow(/timeout/i);
    await vi.advanceTimersByTimeAsync(501);
    await assertion;
    expect(seenSignal?.aborted).toBe(true);
    expect(mockCB.recordFailure).toHaveBeenCalledOnce();
  });

  it("does not send a non-retryable (caller-side) failure to the fallback provider", async () => {
    const fallback = makeClient(() => Promise.resolve(makeResponse("fallback")));
    const primary = makeClient(() => Promise.reject(Object.assign(new Error("invalid api key"), { status: 401 })));
    const client = createResilientClient({ primary, fallback, maxRetries: 0, baseDelayMs: 0 });
    await expect(client.chat(sampleRequest)).rejects.toThrow("invalid api key");
    expect(fallback.chat).not.toHaveBeenCalled();
  });

  it("passes a health predicate to the breaker: 5xx/timeouts count, 4xx do not", async () => {
    const primary = makeClient(() => Promise.resolve(makeResponse("ok")));
    const client = createResilientClient({ primary, maxRetries: 0, baseDelayMs: 0 });
    await client.chat(sampleRequest);
    const isFailure = mockCB.execute.mock.calls[0]![1] as (e: unknown) => boolean;
    expect(isFailure(Object.assign(new Error("x"), { status: 503 }))).toBe(true);
    expect(isFailure(new Error("429 rate limit"))).toBe(true);
    expect(isFailure(Object.assign(new Error("x"), { status: 400 }))).toBe(false);
    expect(isFailure(new Error("context length exceeded: max_tokens 5000"))).toBe(false);
  });
});
