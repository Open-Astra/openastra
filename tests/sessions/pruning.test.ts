import { describe, it, expect } from "vitest";
import {
  pruneToolResults,
  deduplicateToolResults,
  estimateContextTokens,
} from "../../src/sessions/pruning.js";
import type { MessageDoc } from "../../src/sessions/types.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeMsg(
  overrides: Partial<MessageDoc> & { role: MessageDoc["role"] },
): MessageDoc {
  return {
    id: overrides.id ?? "msg-" + Math.random().toString(36).slice(2),
    role: overrides.role,
    content: overrides.content ?? "hello",
    tokenEstimate: overrides.tokenEstimate ?? 10,
    timestamp: overrides.timestamp ?? Date.now(),
    toolCalls: overrides.toolCalls,
    toolCallId: overrides.toolCallId,
  };
}

// ── pruneToolResults ──────────────────────────────────────────────────

describe("pruneToolResults", () => {
  it("returns messages unchanged when there are 5 or fewer", () => {
    const msgs = [
      makeMsg({ role: "user", content: "hello" }),
      makeMsg({ role: "assistant", content: "hi" }),
      makeMsg({ role: "tool", content: "big result data", toolCallId: "call-1" }),
    ];
    const result = pruneToolResults(msgs);
    expect(result).toHaveLength(3);
    expect(result[2]!.content).toBe("big result data");
  });

  it("replaces old tool result messages (beyond last 5) with a summary", () => {
    const msgs: MessageDoc[] = [
      makeMsg({ id: "m1", role: "tool", content: "very long tool output data here", toolCallId: "tc-1" }),
      makeMsg({ id: "m2", role: "user", content: "next question" }),
      makeMsg({ id: "m3", role: "assistant", content: "reply" }),
      makeMsg({ id: "m4", role: "user", content: "another question" }),
      makeMsg({ id: "m5", role: "assistant", content: "another reply" }),
      makeMsg({ id: "m6", role: "user", content: "final question" }),
    ];
    const result = pruneToolResults(msgs);
    // m1 is older than cutoff (last 5 = m2..m6), so it should be summarized
    expect(result[0]!.content).toContain("[Tool:");
    expect(result[0]!.content).toContain("chars");
    // recent messages are untouched
    expect(result[1]!.content).toBe("next question");
  });

  it("strips tool call arguments from old assistant messages with toolCalls", () => {
    const msgs: MessageDoc[] = [
      makeMsg({
        id: "m1",
        role: "assistant",
        content: null as unknown as string,
        toolCalls: [{ id: "tc-1", name: "web_search", arguments: '{"query":"test"}' }],
      }),
      makeMsg({ id: "m2", role: "tool", content: "result", toolCallId: "tc-1" }),
      makeMsg({ id: "m3", role: "user", content: "q3" }),
      makeMsg({ id: "m4", role: "user", content: "q4" }),
      makeMsg({ id: "m5", role: "user", content: "q5" }),
      makeMsg({ id: "m6", role: "user", content: "q6" }),
    ];
    const result = pruneToolResults(msgs);
    // m1 is old assistant with toolCalls — arguments should be stripped
    expect(result[0]!.toolCalls![0]!.arguments).toBe("{}");
    // name and id preserved
    expect(result[0]!.toolCalls![0]!.name).toBe("web_search");
  });

  it("does not modify regular user/assistant messages that are old", () => {
    const msgs: MessageDoc[] = [
      makeMsg({ id: "m1", role: "user", content: "old user message" }),
      makeMsg({ id: "m2", role: "assistant", content: "old assistant message" }),
      makeMsg({ id: "m3", role: "user", content: "r1" }),
      makeMsg({ id: "m4", role: "user", content: "r2" }),
      makeMsg({ id: "m5", role: "user", content: "r3" }),
      makeMsg({ id: "m6", role: "user", content: "r4" }),
    ];
    const result = pruneToolResults(msgs);
    // m1 and m2 are old but not tool messages — they pass through unchanged
    expect(result[0]!.content).toBe("old user message");
    expect(result[1]!.content).toBe("old assistant message");
  });

  it("preserves the last 5 messages verbatim regardless of role", () => {
    const msgs: MessageDoc[] = Array.from({ length: 10 }, (_, i) =>
      makeMsg({ id: `m${i}`, role: "tool", content: `tool result ${i}`, toolCallId: `tc-${i}` }),
    );
    const result = pruneToolResults(msgs);
    // Last 5 (indices 5-9) should be untouched
    for (let i = 5; i < 10; i++) {
      expect(result[i]!.content).toBe(`tool result ${i}`);
    }
    // First 5 should be summarized
    for (let i = 0; i < 5; i++) {
      expect(result[i]!.content).toContain("[Tool:");
    }
  });
});

// ── deduplicateToolResults ────────────────────────────────────────────

describe("deduplicateToolResults", () => {
  it("returns messages unchanged when no duplicates exist", () => {
    const msgs: MessageDoc[] = [
      makeMsg({ id: "m1", role: "tool", content: "result one abc def ghi jkl mno", toolCallId: "tc-1" }),
      makeMsg({ id: "m2", role: "tool", content: "completely different result xyz uvw rst", toolCallId: "tc-2" }),
    ];
    const result = deduplicateToolResults(msgs);
    expect(result).toHaveLength(2);
    expect(result[0]!.content).toBe("result one abc def ghi jkl mno");
    expect(result[1]!.content).toBe("completely different result xyz uvw rst");
  });

  it("deduplicates tool results with >80% overlap from same tool, keeping the newer one", () => {
    const sharedContent = "abcdabcdabcdabcdabcdabcdabcdabcdabcd"; // repeated chars for high overlap
    const msgs: MessageDoc[] = [
      makeMsg({ id: "m1", role: "assistant", content: null as unknown as string, toolCalls: [{ id: "tc-1", name: "web_search", arguments: "{}" }] }),
      makeMsg({ id: "m2", role: "tool", content: sharedContent, toolCallId: "tc-1" }),
      makeMsg({ id: "m3", role: "assistant", content: null as unknown as string, toolCalls: [{ id: "tc-2", name: "web_search", arguments: "{}" }] }),
      makeMsg({ id: "m4", role: "tool", content: sharedContent, toolCallId: "tc-2" }),
    ];
    const result = deduplicateToolResults(msgs);
    // The older one (m2) should be marked as deduplicated
    expect(result[1]!.content).toContain("deduplicated");
    // The newer one (m4) should be kept intact
    expect(result[3]!.content).toBe(sharedContent);
  });

  it("returns original messages unmodified when no tool messages exist", () => {
    const msgs: MessageDoc[] = [
      makeMsg({ role: "user", content: "hello" }),
      makeMsg({ role: "assistant", content: "world" }),
    ];
    const result = deduplicateToolResults(msgs);
    expect(result[0]!.content).toBe("hello");
    expect(result[1]!.content).toBe("world");
  });
});

// ── estimateContextTokens ─────────────────────────────────────────────

describe("estimateContextTokens", () => {
  it("sums tokenEstimate across all messages", () => {
    const msgs: MessageDoc[] = [
      makeMsg({ role: "user", content: "hi", tokenEstimate: 5 }),
      makeMsg({ role: "assistant", content: "hello", tokenEstimate: 10 }),
      makeMsg({ role: "tool", content: "result", tokenEstimate: 20 }),
    ];
    expect(estimateContextTokens(msgs)).toBe(35);
  });

  it("returns 0 for empty message list", () => {
    expect(estimateContextTokens([])).toBe(0);
  });

  it("returns the single message estimate for a single message", () => {
    const msgs: MessageDoc[] = [makeMsg({ role: "user", content: "test", tokenEstimate: 42 })];
    expect(estimateContextTokens(msgs)).toBe(42);
  });
});
