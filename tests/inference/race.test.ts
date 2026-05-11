import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../../src/utils/logger.js", () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    dim: vi.fn(),
    active: vi.fn(),
  }),
}));

import { raceInference, raceInferenceStream } from "../../src/inference/race.js";
import type { InferenceClient, InferenceRequest, InferenceResponse, InferenceStreamDelta } from "../../src/inference/types.js";

// ── Helpers ───────────────────────────────────────────────────────────

const sampleRequest: InferenceRequest = {
  messages: [{ role: "user", content: "hello" }],
};

function makeResponse(content: string, extra: Partial<InferenceResponse> = {}): InferenceResponse {
  return {
    content,
    toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    finishReason: "stop",
    ...extra,
  };
}

function makeDelayedClient(content: string, delayMs: number, shouldFail = false): InferenceClient {
  return {
    chat: vi.fn().mockImplementation(
      () =>
        new Promise<InferenceResponse>((resolve, reject) =>
          setTimeout(() => {
            if (shouldFail) reject(new Error(`${content} failed`));
            else resolve(makeResponse(content));
          }, delayMs),
        ),
    ),
    async *chatStream() {
      await new Promise<void>((resolve, reject) =>
        setTimeout(() => {
          if (shouldFail) reject(new Error(`${content} stream failed`));
          else resolve();
        }, delayMs),
      );
      if (!shouldFail) {
        yield { type: "content" as const, content };
        yield { type: "done" as const, usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } };
      }
    },
  };
}

describe("raceInference", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fastest provider wins the race", async () => {
    const fast = makeDelayedClient("fast-response", 10);
    const slow = makeDelayedClient("slow-response", 500);

    const result = await raceInference(sampleRequest, {
      clients: [
        { client: slow, label: "slow" },
        { client: fast, label: "fast" },
      ],
    });

    expect(result.winner).toBe("fast");
    expect(result.response.content).toBe("fast-response");
  });

  it("slower provider result is discarded — loserMs contains slower label", async () => {
    const fast = makeDelayedClient("winner", 10);
    const slow = makeDelayedClient("loser", 200);

    const result = await raceInference(sampleRequest, {
      clients: [
        { client: fast, label: "provider-a" },
        { client: slow, label: "provider-b" },
      ],
    });

    expect(result.winner).toBe("provider-a");
    expect(result.loserMs).toHaveProperty("provider-b");
    expect(result.loserMs).not.toHaveProperty("provider-a");
  });

  it("both providers fail → throws AggregateError (Promise.any semantics)", async () => {
    const failA = makeDelayedClient("a", 10, true);
    const failB = makeDelayedClient("b", 20, true);

    await expect(
      raceInference(sampleRequest, {
        clients: [
          { client: failA, label: "a" },
          { client: failB, label: "b" },
        ],
      }),
    ).rejects.toThrow();
  });

  it("usage from winning provider is returned correctly", async () => {
    const winner = {
      chat: vi.fn().mockResolvedValue(makeResponse("ok", {
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      })),
      async *chatStream() { yield { type: "done" as const }; },
    };
    const loser = makeDelayedClient("slow", 500);

    const result = await raceInference(sampleRequest, {
      clients: [
        { client: winner, label: "winner" },
        { client: loser, label: "loser" },
      ],
    });

    expect(result.response.usage.promptTokens).toBe(100);
    expect(result.response.usage.completionTokens).toBe(50);
    expect(result.response.usage.totalTokens).toBe(150);
  });

  it("single provider (no race) works normally", async () => {
    const solo = {
      chat: vi.fn().mockResolvedValue(makeResponse("solo response")),
      async *chatStream() { yield { type: "done" as const }; },
    };

    const result = await raceInference(sampleRequest, {
      clients: [{ client: solo, label: "solo" }],
    });

    expect(result.winner).toBe("solo");
    expect(result.response.content).toBe("solo response");
    expect(result.loserMs).toEqual({});
  });

  it("timeout causes rejection when all providers are too slow", async () => {
    const slowA = makeDelayedClient("a", 500);
    const slowB = makeDelayedClient("b", 500);

    await expect(
      raceInference(sampleRequest, {
        clients: [
          { client: slowA, label: "slow-a" },
          { client: slowB, label: "slow-b" },
        ],
        timeoutMs: 50,
      }),
    ).rejects.toThrow("Race timeout");
  });
});

describe("raceInferenceStream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fastest streaming provider's chunks are yielded first", async () => {
    const fast: InferenceClient = {
      chat: vi.fn(),
      async *chatStream(_req: InferenceRequest): AsyncIterable<InferenceStreamDelta> {
        await new Promise((r) => setTimeout(r, 5));
        yield { type: "content", content: "fast-chunk" };
        yield { type: "done", usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } };
      },
    };

    const slow: InferenceClient = {
      chat: vi.fn(),
      async *chatStream(_req: InferenceRequest): AsyncIterable<InferenceStreamDelta> {
        await new Promise((r) => setTimeout(r, 300));
        yield { type: "content", content: "slow-chunk" };
        yield { type: "done", usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } };
      },
    };

    const collected: Array<InferenceStreamDelta & { winner?: string }> = [];
    for await (const delta of raceInferenceStream(sampleRequest, {
      clients: [
        { client: fast, label: "fast" },
        { client: slow, label: "slow" },
      ],
    })) {
      collected.push(delta);
    }

    // First chunk should have winner tag from fast provider
    expect(collected[0]?.winner).toBe("fast");
    const contentChunks = collected.filter((d) => d.type === "content");
    expect(contentChunks.every((c) => c.content === "fast-chunk")).toBe(true);
  });

  it("all providers failing to stream throws an error", async () => {
    const failClient: InferenceClient = {
      chat: vi.fn(),
      async *chatStream(): AsyncIterable<InferenceStreamDelta> {
        throw new Error("stream died immediately");
      },
    };

    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of raceInferenceStream(sampleRequest, {
        clients: [
          { client: failClient, label: "fail-a" },
          { client: failClient, label: "fail-b" },
        ],
      })) { /* drain */ }
    }).rejects.toThrow("All providers failed to produce a stream chunk");
  });
});
