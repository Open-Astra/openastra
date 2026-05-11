import { vi, describe, it, expect, beforeEach } from "vitest";
import type { InferenceClient, InferenceResponse } from "../../src/inference/types.js";

// ── Tests for src/agents/reflection.ts ──────────────────────────────

describe("shouldReflect", () => {
  // Import is at the bottom after mocks — but reflection.ts has no mocks,
  // it only imports InferenceClient (a type). We import the module directly.
  it("returns true when a tool result has an error", async () => {
    const { shouldReflect } = await import("../../src/agents/reflection.js");

    const result = shouldReflect(
      [{ name: "web-search", error: "timeout" }],
      100,
    );
    expect(result).toBe(true);
  });

  it("returns true when response is long (> 2000 chars) even without errors", async () => {
    const { shouldReflect } = await import("../../src/agents/reflection.js");

    const result = shouldReflect(
      [{ name: "web-search" }],
      2001,
    );
    expect(result).toBe(true);
  });

  it("returns true when 3 or more tools were used", async () => {
    const { shouldReflect } = await import("../../src/agents/reflection.js");

    const result = shouldReflect(
      [{ name: "tool-a" }, { name: "tool-b" }, { name: "tool-c" }],
      50,
    );
    expect(result).toBe(true);
  });

  it("returns false for short response with no errors and few tools", async () => {
    const { shouldReflect } = await import("../../src/agents/reflection.js");

    const result = shouldReflect(
      [{ name: "tool-a" }, { name: "tool-b" }],
      500,
    );
    expect(result).toBe(false);
  });

  it("returns false when no tools were used and response is short", async () => {
    const { shouldReflect } = await import("../../src/agents/reflection.js");

    const result = shouldReflect([], 200);
    expect(result).toBe(false);
  });
});

describe("reflectOnResponse", () => {
  function makeMockClient(content: string): InferenceClient {
    const response: InferenceResponse = {
      content,
      toolCalls: [],
      usage: { promptTokens: 50, completionTokens: 100, totalTokens: 150 },
      finishReason: "stop",
    };
    return {
      chat: vi.fn().mockResolvedValue(response),
      chatStream: vi.fn(),
    };
  }

  beforeEach(() => {
    vi.resetModules();
  });

  it("detects issues and returns shouldRevise:true", async () => {
    const { reflectOnResponse } = await import("../../src/agents/reflection.js");

    const payload = JSON.stringify({
      confidence: 0.3,
      issues: ["Wrong fact", "Missing context"],
      suggestions: ["Add source", "Clarify"],
      shouldRevise: true,
    });
    const client = makeMockClient(payload);

    const result = await reflectOnResponse("What is X?", "X is Y.", client, "sess-1");

    expect(result.shouldRevise).toBe(true);
    expect(result.issues).toEqual(["Wrong fact", "Missing context"]);
    expect(result.confidence).toBeCloseTo(0.3);
  });

  it("returns shouldRevise:false for a high-quality response", async () => {
    const { reflectOnResponse } = await import("../../src/agents/reflection.js");

    const payload = JSON.stringify({
      confidence: 0.95,
      issues: [],
      suggestions: [],
      shouldRevise: false,
    });
    const client = makeMockClient(payload);

    const result = await reflectOnResponse("Tell me about Z.", "Z is well-documented.", client, "sess-2");

    expect(result.shouldRevise).toBe(false);
    expect(result.issues).toHaveLength(0);
    expect(result.confidence).toBeCloseTo(0.95);
  });

  it("caps confidence between 0 and 1 even if LLM returns out-of-range value", async () => {
    const { reflectOnResponse } = await import("../../src/agents/reflection.js");

    const payload = JSON.stringify({
      confidence: 1.5,
      issues: [],
      suggestions: [],
      shouldRevise: false,
    });
    const client = makeMockClient(payload);

    const result = await reflectOnResponse("Q", "A", client, "sess-3");

    expect(result.confidence).toBeLessThanOrEqual(1.0);
    expect(result.confidence).toBeGreaterThanOrEqual(0.0);
  });

  it("returns default values when LLM response has no JSON", async () => {
    const { reflectOnResponse } = await import("../../src/agents/reflection.js");

    const client = makeMockClient("This is a plain text response with no JSON.");

    const result = await reflectOnResponse("Q", "A", client, "sess-4");

    // Default for no-JSON case is confidence=0.7, shouldRevise=false
    expect(result.confidence).toBe(0.7);
    expect(result.shouldRevise).toBe(false);
    expect(result.issues).toEqual([]);
  });

  it("returns graceful fallback when inference client throws", async () => {
    const { reflectOnResponse } = await import("../../src/agents/reflection.js");

    const client: InferenceClient = {
      chat: vi.fn().mockRejectedValue(new Error("network error")),
      chatStream: vi.fn(),
    };

    const result = await reflectOnResponse("Q", "A", client, "sess-5");

    // Error path returns confidence=0.5, shouldRevise=false
    expect(result.confidence).toBe(0.5);
    expect(result.shouldRevise).toBe(false);
    expect(result.issues).toContain("Reflection failed");
  });

  it("limits issues and suggestions arrays to 3 entries", async () => {
    const { reflectOnResponse } = await import("../../src/agents/reflection.js");

    const payload = JSON.stringify({
      confidence: 0.4,
      issues: ["i1", "i2", "i3", "i4", "i5"],
      suggestions: ["s1", "s2", "s3", "s4"],
      shouldRevise: true,
    });
    const client = makeMockClient(payload);

    const result = await reflectOnResponse("Q", "A", client, "sess-6");

    expect(result.issues).toHaveLength(3);
    expect(result.suggestions).toHaveLength(3);
  });
});
