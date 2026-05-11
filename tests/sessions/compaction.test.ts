import { vi, describe, it, expect, beforeEach } from "vitest";

const { mockPool } = vi.hoisted(() => {
  const pool = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    connect: vi.fn().mockResolvedValue({ query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() }),
    end: vi.fn(),
    on: vi.fn(),
    totalCount: 1,
    idleCount: 1,
    waitingCount: 0,
  };
  return { mockPool: pool };
});

vi.mock("../../src/config/postgres.js", () => ({
  getPool: () => mockPool,
}));

// Mock persistMessage to return a compaction message doc
vi.mock("../../src/sessions/store.js", () => ({
  persistMessage: vi.fn().mockImplementation(
    async (_uid: string, sessionId: string, msg: { role: string; content: string; tokenEstimate: number; timestamp: number }) => ({
      id: "compaction-msg-id",
      ...msg,
    }),
  ),
}));

// Mock the memory indexer to avoid Typesense dependency
vi.mock("../../src/memory/indexer.js", () => ({
  indexSessionSummary: vi.fn().mockResolvedValue(undefined),
}));

// Mock the context assembler (used by preCompactionFlush)
vi.mock("../../src/context/assembler.js", () => ({
  assembleContext: vi.fn().mockResolvedValue({
    messages: [{ role: "system", content: "system prompt" }],
    estimatedTokens: 100,
  }),
}));

// Mock tools index (used by preCompactionFlush)
vi.mock("../../src/tools/index.js", () => ({
  getToolSchemas: vi.fn().mockReturnValue([]),
  executeTool: vi.fn().mockResolvedValue({ result: "done" }),
}));

// Mock tool types (used by preCompactionFlush)
vi.mock("../../src/tools/types.js", () => ({
  resolveToolPolicy: vi.fn().mockReturnValue({ allow: ["memory_write"], deny: [] }),
}));

import { shouldCompact, compactSession, preCompactionFlush } from "../../src/sessions/compaction.js";
import type { MessageDoc } from "../../src/sessions/types.js";
import type { AgentConfig } from "../../src/agents/types.js";
import type { InferenceClient, InferenceResponse } from "../../src/inference/types.js";

// ── Helpers ───────────────────────────────────────────────────────────

function makeMsg(
  role: MessageDoc["role"],
  content: string,
  id?: string,
): MessageDoc {
  return {
    id: id ?? "msg-" + Math.random().toString(36).slice(2),
    role,
    content,
    tokenEstimate: Math.ceil(content.length / 4),
    timestamp: Date.now(),
  };
}

function makeAgentConfig(maxContextTokens = 4000): AgentConfig {
  return {
    id: "agent-1",
    displayName: "Test Agent",
    tier: "free",
    model: {
      provider: "openai" as const,
      modelId: "gpt-4o",
      maxContextTokens,
      maxOutputTokens: 2048,
      temperature: 0.7,
    },
    systemPromptTemplate: "You are a test agent.",
    tools: { allow: [], deny: [], maxToolCallsPerRound: 5 },
    session: { idleTimeoutMinutes: 60, dailyResetHour: 0, maxContextMessages: 50 },
    spawn: { enabled: false, allowedTargets: [], maxDepth: 2 },
    fileAccess: { restricted: true, allowedPaths: [] },
    skills: [],
    memory: { enabled: false, autoSave: false },
    tags: [],
  } as unknown as AgentConfig;
}

function makeInferenceClient(summary = "This is a conversation summary."): InferenceClient {
  return {
    chat: vi.fn().mockResolvedValue({
      content: summary,
      toolCalls: [],
      inputTokens: 100,
      outputTokens: 50,
    } satisfies InferenceResponse),
    chatStream: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPool.query.mockResolvedValue({ rows: [] });
});

// ── shouldCompact ─────────────────────────────────────────────────────

describe("shouldCompact", () => {
  it("returns false when messages are well under 70% of token budget", () => {
    // Budget = 4000, threshold = 2800
    // Each message is "short" → ~2 tokens each
    const messages = Array.from({ length: 5 }, (_, i) =>
      makeMsg("user", "hi", `m${i}`),
    );
    const agentConfig = makeAgentConfig(4000);
    expect(shouldCompact(messages, agentConfig)).toBe(false);
  });

  it("returns true when total tokens exceed 70% of the budget", () => {
    // Budget = 100 tokens, threshold = 70
    // Each message content is 400 chars → ~100 tokens each
    // 2 messages = ~200 tokens → well over 70
    const bigContent = "x".repeat(400);
    const messages = [
      makeMsg("user", bigContent, "m1"),
      makeMsg("assistant", bigContent, "m2"),
    ];
    const agentConfig = makeAgentConfig(100);
    expect(shouldCompact(messages, agentConfig)).toBe(true);
  });

  it("returns false for empty message list", () => {
    expect(shouldCompact([], makeAgentConfig(4000))).toBe(false);
  });
});

// ── compactSession ────────────────────────────────────────────────────

describe("compactSession", () => {
  it("returns all messages unchanged when count is <= KEEP_RECENT (10)", async () => {
    const messages = Array.from({ length: 8 }, (_, i) =>
      makeMsg("user", `message ${i}`, `m${i}`),
    );
    const client = makeInferenceClient();
    const result = await compactSession("uid-1", "sess-1", messages, makeAgentConfig(), client);
    expect(result).toEqual(messages);
  });

  it("summarizes older messages and keeps recent 10", async () => {
    const messages = Array.from({ length: 15 }, (_, i) =>
      makeMsg(i % 2 === 0 ? "user" : "assistant", `Message content ${i}`, `m${i}`),
    );
    const client = makeInferenceClient("Summary of old messages.");

    const result = await compactSession("uid-1", "sess-1", messages, makeAgentConfig(), client);

    // Should have compaction message + last 10 messages
    expect(result).toHaveLength(11);

    // First message is the compaction summary
    expect(result[0]!.role).toBe("system");
    expect(result[0]!.content).toContain("[Conversation summary]");
    expect(result[0]!.content).toContain("Summary of old messages.");

    // Last 10 messages are the originals
    for (let i = 1; i <= 10; i++) {
      expect(result[i]!.id).toBe(messages[messages.length - 10 + i - 1]!.id);
    }
  });

  it("calls inference client with a summarization request", async () => {
    const messages = Array.from({ length: 12 }, (_, i) =>
      makeMsg("user", `Content ${i}`, `m${i}`),
    );
    const client = makeInferenceClient("Brief summary here.");

    await compactSession("uid-1", "sess-1", messages, makeAgentConfig(), client);

    expect(client.chat).toHaveBeenCalledTimes(1);
    const callArg = (client.chat as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    // Should include a system message with summarize prompt
    expect(callArg.messages[0].role).toBe("system");
    expect(callArg.temperature).toBe(0.3);
  });

  it("archives old messages and deletes them from DB", async () => {
    const messages = Array.from({ length: 12 }, (_, i) =>
      makeMsg("user", `Content ${i}`, `uuid-m${i}`),
    );
    const client = makeInferenceClient("Summary.");

    await compactSession("uid-1", "sess-1", messages, makeAgentConfig(), client);

    // Should have called INSERT INTO message_archive
    const archiveCall = mockPool.query.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("message_archive"),
    );
    expect(archiveCall).toBeDefined();

    // Should have called DELETE FROM messages
    const deleteCall = mockPool.query.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("DELETE FROM messages"),
    );
    expect(deleteCall).toBeDefined();
  });

  it("updates session with compaction summary", async () => {
    const messages = Array.from({ length: 12 }, (_, i) =>
      makeMsg("user", `Content ${i}`, `uuid-m${i}`),
    );
    const client = makeInferenceClient("The session covered topics X and Y.");

    await compactSession("uid-1", "sess-1", messages, makeAgentConfig(), client);

    const updateCall = mockPool.query.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("UPDATE sessions") &&
        (c[0] as string).includes("compaction_summary"),
    );
    expect(updateCall).toBeDefined();
    const params = updateCall![1] as unknown[];
    expect(params[0]).toContain("The session covered topics X and Y.");
    expect(params[1]).toBe("sess-1");
  });
});

// ── preCompactionFlush ────────────────────────────────────────────────

describe("preCompactionFlush", () => {
  it("calls inference client once to extract memories before compaction", async () => {
    const messages = Array.from({ length: 5 }, (_, i) =>
      makeMsg("user", `Content ${i}`, `m${i}`),
    );
    const client = makeInferenceClient();

    await preCompactionFlush("uid-1", "sess-1", messages, makeAgentConfig(), client);

    expect(client.chat).toHaveBeenCalledTimes(1);
  });

  it("executes memory_write tool calls returned by the inference client", async () => {
    const { executeTool } = await import("../../src/tools/index.js");

    const messages = [makeMsg("user", "Remember this: I prefer dark mode.", "m1")];
    const clientWithToolCall: InferenceClient = {
      chat: vi.fn().mockResolvedValue({
        content: null,
        toolCalls: [
          {
            id: "tc-1",
            name: "memory_write",
            arguments: JSON.stringify({ content: "User prefers dark mode", category: "preference" }),
          },
        ],
        inputTokens: 100,
        outputTokens: 20,
      } satisfies InferenceResponse),
      chatStream: vi.fn(),
    };

    await preCompactionFlush("uid-1", "sess-1", messages, makeAgentConfig(), clientWithToolCall);

    expect(executeTool).toHaveBeenCalledTimes(1);
    const callArg = (executeTool as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(callArg[0].name).toBe("memory_write");
  });
});
