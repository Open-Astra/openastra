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

import { warmPool, prewarm } from "../../src/inference/warm-pool.js";
import type { InferenceClient } from "../../src/inference/types.js";

// ── Helpers ───────────────────────────────────────────────────────────

function makeClient(id: string): InferenceClient {
  return {
    chat: vi.fn().mockResolvedValue({ content: id, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop" }),
    async *chatStream() { yield { type: "done" as const }; },
  };
}

// Drain warm pool before each test to ensure clean state.
// The WarmPool singleton persists between tests because it is module-level.
function drainPool() {
  // Keep calling get with arbitrary keys until poolSize is 0 is not possible
  // since get requires specific provider/modelId. Instead we just need to
  // empty anything we add in each test. We track what we add.
}

describe("WarmPool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Remove any leftover entries by consuming them individually
    // (We can't reset the singleton, but we test with unique provider/model combos)
  });

  it("get() returns null on cold miss (entry not in pool)", () => {
    const result = warmPool.get("nonexistent-provider", "nonexistent-model");
    expect(result).toBeNull();
  });

  it("add() then get() returns the stored client", () => {
    const client = makeClient("test-client");
    warmPool.add("openai", "gpt-4o-pool-test", client);
    const retrieved = warmPool.get("openai", "gpt-4o-pool-test");
    expect(retrieved).toBe(client);
  });

  it("get() consumes the entry — second get() returns null (consumed once)", () => {
    const client = makeClient("consumed-once");
    warmPool.add("gemini", "gemini-2.0-consumed", client);
    const first = warmPool.get("gemini", "gemini-2.0-consumed");
    expect(first).toBe(client);
    // Second get() should return null since the entry was consumed
    const second = warmPool.get("gemini", "gemini-2.0-consumed");
    expect(second).toBeNull();
  });

  it("poolSize() reflects current pool count", () => {
    const clientA = makeClient("a");
    const clientB = makeClient("b");
    const sizeBefore = warmPool.poolSize();

    warmPool.add("claude", "claude-size-a", clientA);
    warmPool.add("claude", "claude-size-b", clientB);
    expect(warmPool.poolSize()).toBe(sizeBefore + 2);

    warmPool.get("claude", "claude-size-a");
    expect(warmPool.poolSize()).toBe(sizeBefore + 1);

    warmPool.get("claude", "claude-size-b");
    expect(warmPool.poolSize()).toBe(sizeBefore);
  });

  it("evicts oldest entry when pool exceeds maxSize (default 3)", () => {
    // Fill beyond maxSize=3 using unique model ids to avoid cross-test contamination
    const clients = Array.from({ length: 4 }, (_, i) => makeClient(`evict-${i}`));

    warmPool.add("grok", "evict-model-0", clients[0]!);
    warmPool.add("grok", "evict-model-1", clients[1]!);
    warmPool.add("grok", "evict-model-2", clients[2]!);
    // Adding a 4th should evict evict-model-0 (oldest)
    warmPool.add("grok", "evict-model-3", clients[3]!);

    // evict-model-0 should have been evicted
    const evicted = warmPool.get("grok", "evict-model-0");
    expect(evicted).toBeNull();

    // evict-model-3 should still be present
    const newest = warmPool.get("grok", "evict-model-3");
    expect(newest).toBe(clients[3]);

    // Clean up remaining entries
    warmPool.get("grok", "evict-model-1");
    warmPool.get("grok", "evict-model-2");
  });
});

describe("prewarm()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pre-warms all specified models and stores them in the pool", async () => {
    const mockCreateClient = vi.fn().mockImplementation((provider: string, modelId: string) =>
      makeClient(`${provider}:${modelId}`),
    );

    await prewarm(["openai:gpt-4o-prewarm", "claude:claude-haiku-prewarm"], mockCreateClient);

    expect(mockCreateClient).toHaveBeenCalledTimes(2);
    expect(mockCreateClient).toHaveBeenCalledWith("openai", "gpt-4o-prewarm");
    expect(mockCreateClient).toHaveBeenCalledWith("claude", "claude-haiku-prewarm");

    // Verify clients are in pool
    const client1 = warmPool.get("openai", "gpt-4o-prewarm");
    const client2 = warmPool.get("claude", "claude-haiku-prewarm");
    expect(client1).not.toBeNull();
    expect(client2).not.toBeNull();
  });

  it("skips malformed specs (missing provider or modelId)", async () => {
    const mockCreateClient = vi.fn().mockReturnValue(makeClient("fallback"));

    await prewarm(["", "openai", ":gpt-4o-no-provider"], mockCreateClient);

    // None of these malformed specs should call createClient
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("continues pre-warming remaining models when one fails", async () => {
    const mockCreateClient = vi.fn()
      .mockImplementationOnce(() => { throw new Error("creation failed"); })
      .mockImplementationOnce((provider: string, modelId: string) => makeClient(`${provider}:${modelId}`));

    await expect(
      prewarm(["groq:fail-model", "groq:groq-success-prewarm"], mockCreateClient),
    ).resolves.toBeUndefined();

    expect(mockCreateClient).toHaveBeenCalledTimes(2);
    // Success one should still be in the pool
    const successClient = warmPool.get("groq", "groq-success-prewarm");
    expect(successClient).not.toBeNull();
  });
});
