import { vi, describe, it, expect, beforeEach } from "vitest";

// vi.hoisted runs before vi.mock factories are evaluated (synchronous only).
// We inline the mock objects here so they are available in factory closures.
const { mockPool, mockBus } = vi.hoisted(() => {
  const pool = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    connect: vi.fn().mockResolvedValue({ query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() }),
    end: vi.fn(),
    on: vi.fn(),
    totalCount: 1,
    idleCount: 1,
    waitingCount: 0,
  };
  const bus = {
    emit: vi.fn(),
    on: vi.fn().mockReturnValue(() => {}),
    once: vi.fn().mockReturnValue(() => {}),
    off: vi.fn(),
    onAny: vi.fn().mockReturnValue(() => {}),
    clear: vi.fn(),
    listenerCount: vi.fn().mockReturnValue(0),
  };
  return { mockPool: pool, mockBus: bus };
});

// ALL vi.mock calls MUST come before any imports of the module under test

vi.mock("../../src/sessions/store.js", () => ({
  resolveSession: vi.fn(),
  persistMessage: vi.fn(),
}));

vi.mock("../../src/sessions/compaction.js", () => ({
  shouldCompact: vi.fn().mockReturnValue(false),
  preCompactionFlush: vi.fn().mockResolvedValue(undefined),
  compactSession: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/context/assembler.js", () => ({
  assembleContext: vi.fn().mockImplementation(async (_uid: unknown, _config: unknown, messages: Array<{ role: string; content: string }>) => ({
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    estimatedTokens: 200,
  })),
  trimToolSchemas: vi.fn().mockImplementation((schemas: unknown) => schemas),
}));

vi.mock("../../src/tools/index.js", () => ({
  getToolSchemas: vi.fn().mockReturnValue([]),
  executeTool: vi.fn().mockResolvedValue({
    toolCallId: "tc-1",
    name: "test-tool",
    content: '{"result":"ok"}',
    durationMs: 50,
  }),
}));

vi.mock("../../src/events/index.js", () => ({
  getEventBus: vi.fn().mockReturnValue(mockBus),
}));

vi.mock("../../src/agents/lifecycle.js", () => ({
  emitAgentStarted: vi.fn(),
  emitToolCallStart: vi.fn(),
  emitToolCallEnd: vi.fn(),
  emitAgentCompleted: vi.fn(),
  emitAgentStreaming: vi.fn(),
  emitAgentError: vi.fn(),
}));

vi.mock("../../src/webhooks/dispatcher.js", () => ({
  fireWebhooksForEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/skills/registry.js", () => ({
  getSkillToolNames: vi.fn().mockReturnValue([]),
}));

vi.mock("../../src/agents/post-turn-save.js", () => ({
  postTurnAutoSave: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/memory/graph.js", () => ({
  graphSearch: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/memory/auto-extract.js", () => ({
  reinforceEntity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/config/postgres.js", () => ({
  getPool: () => mockPool,
}));

vi.mock("../../src/agents/reflection.js", () => ({
  shouldReflect: vi.fn().mockReturnValue(false),
  reflectOnResponse: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/agents/tracer.js", () => {
  class AgentTracer {
    start = vi.fn();
    addToolCall = vi.fn();
    setTokens = vi.fn();
    finish = vi.fn();
    constructor(_opts: unknown) {}
  }
  return { AgentTracer };
});

vi.mock("../../src/memory/profiles.js", () => ({
  getAgentProfile: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/inference/payload-audit.js", () => ({
  writeInferencePayload: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/agents/mood.js", () => ({
  getMood: vi.fn().mockResolvedValue("neutral"),
  updateMood: vi.fn().mockResolvedValue(undefined),
  getMoodSystemSuffix: vi.fn().mockReturnValue(""),
}));

vi.mock("../../src/agents/tone-drift.js", () => ({
  classifyTone: vi.fn().mockReturnValue("neutral"),
  detectToneDrift: vi.fn().mockReturnValue({ drifted: false }),
}));

vi.mock("../../src/agents/confidence.js", () => ({
  extractConfidenceSignals: vi.fn().mockReturnValue(0.9),
}));

vi.mock("../../src/agents/persona.js", () => ({
  detectPersonaContext: vi.fn().mockReturnValue(null),
}));

vi.mock("../../src/agents/goals.js", () => ({
  loadActiveGoals: vi.fn().mockResolvedValue([]),
  buildGoalContext: vi.fn().mockReturnValue(""),
}));

vi.mock("../../src/utils/ssrf-guard.js", () => ({
  isBlockedUrl: vi.fn().mockResolvedValue(false),
}));

// All vi.mock calls are done — now import the module under test and helpers

import { runAgentLoop } from "../../src/agents/loop.js";
import {
  createTestAgentConfig,
  makeTextResponse,
  makeToolCallResponse,
  createMockInferenceClient,
  createMockSession,
  mockPersistMessage,
  resetMsgCounter,
} from "./fixtures.js";
import { resolveSession, persistMessage } from "../../src/sessions/store.js";
import { assembleContext } from "../../src/context/assembler.js";
import { executeTool, getToolSchemas } from "../../src/tools/index.js";
import { getEventBus } from "../../src/events/index.js";
import type { MessageDoc } from "../../src/sessions/types.js";

// ── beforeEach ──────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  resetMsgCounter();
  // Re-wire mocks that were cleared
  vi.mocked(resolveSession).mockResolvedValue(createMockSession("sess-1"));
  vi.mocked(persistMessage).mockImplementation(async (_uid, _sid, msg) =>
    mockPersistMessage(_uid, _sid, msg as Omit<MessageDoc, "id">),
  );
  vi.mocked(getEventBus).mockReturnValue(mockBus);
});

// ── Tests ───────────────────────────────────────────────────────────

describe("runAgentLoop", () => {
  it("simple chat — no tools", async () => {
    const config = createTestAgentConfig();
    const client = createMockInferenceClient([makeTextResponse("Hello!")]);

    const result = await runAgentLoop("user-1", "Hi", config, client);

    expect(result.content).toBe("Hello!");
    expect(result.toolResults).toEqual([]);
    expect(result.sessionId).toBe("sess-1");

    expect(resolveSession).toHaveBeenCalledOnce();
    expect(persistMessage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(client.chat)).toHaveBeenCalledOnce();

    const emitCalls = vi.mocked(mockBus.emit).mock.calls.map((c) => c[0]);
    expect(emitCalls).toContain("agent.started");
    expect(emitCalls).toContain("agent.completed");
  });

  it("multi-turn conversation", async () => {
    const config = createTestAgentConfig();

    // Turn 1 — fresh session with no existing messages
    const client1 = createMockInferenceClient([makeTextResponse("Response 1")]);
    await runAgentLoop("user-1", "Message 1", config, client1);
    expect(resolveSession).toHaveBeenCalledOnce();

    // Reset mocks between turns to isolate call counts
    vi.clearAllMocks();
    resetMsgCounter();
    vi.mocked(getEventBus).mockReturnValue(mockBus);
    vi.mocked(persistMessage).mockImplementation(async (_uid, _sid, msg) =>
      mockPersistMessage(_uid, _sid, msg as Omit<MessageDoc, "id">),
    );

    // Turn 2 — simulate 2 existing messages in session
    vi.mocked(resolveSession).mockResolvedValue({
      ...createMockSession("sess-1"),
      messages: [
        { id: "old-1", role: "user", content: "Message 1", timestamp: Date.now(), tokenEstimate: 10 },
        { id: "old-2", role: "assistant", content: "Response 1", timestamp: Date.now(), tokenEstimate: 10 },
      ],
    });
    const client2 = createMockInferenceClient([makeTextResponse("Response 2")]);
    await runAgentLoop("user-1", "Message 2", config, client2);

    // assembleContext receives allMessages = [2 existing + 1 new user msg] = 3
    const assembleCall2 = vi.mocked(assembleContext).mock.calls[0];
    const messagesArg2 = assembleCall2[2] as Array<{ role: string }>;
    expect(messagesArg2.length).toBe(3);

    vi.clearAllMocks();
    resetMsgCounter();
    vi.mocked(getEventBus).mockReturnValue(mockBus);
    vi.mocked(persistMessage).mockImplementation(async (_uid, _sid, msg) =>
      mockPersistMessage(_uid, _sid, msg as Omit<MessageDoc, "id">),
    );

    // Turn 3 — simulate 4 existing messages
    vi.mocked(resolveSession).mockResolvedValue({
      ...createMockSession("sess-1"),
      messages: [
        { id: "old-1", role: "user", content: "Message 1", timestamp: Date.now(), tokenEstimate: 10 },
        { id: "old-2", role: "assistant", content: "Response 1", timestamp: Date.now(), tokenEstimate: 10 },
        { id: "old-3", role: "user", content: "Message 2", timestamp: Date.now(), tokenEstimate: 10 },
        { id: "old-4", role: "assistant", content: "Response 2", timestamp: Date.now(), tokenEstimate: 10 },
      ],
    });
    const client3 = createMockInferenceClient([makeTextResponse("Response 3")]);
    await runAgentLoop("user-1", "Message 3", config, client3);

    // assembleContext receives [4 existing + 1 new user msg] = 5
    const assembleCall3 = vi.mocked(assembleContext).mock.calls[0];
    const messagesArg3 = assembleCall3[2] as Array<{ role: string }>;
    expect(messagesArg3.length).toBe(5);
  });

  it("tool execution — single round", async () => {
    const config = createTestAgentConfig({
      tools: { allow: ["test-tool"], deny: [], maxToolCallsPerRound: 8 },
    });

    vi.mocked(getToolSchemas).mockReturnValue([
      { type: "function", function: { name: "test-tool", description: "Test", parameters: {} } } as ReturnType<typeof getToolSchemas>[number],
    ]);

    vi.mocked(executeTool).mockImplementation(async (call) => ({
      toolCallId: call.id,
      name: call.name,
      content: '{"ok":true}',
      durationMs: 42,
    }));

    const client = createMockInferenceClient([
      makeToolCallResponse([{ id: "tc-1", name: "test-tool", arguments: '{"q":"test"}' }]),
      makeTextResponse("Done"),
    ]);

    const result = await runAgentLoop("user-1", "Use the tool", config, client);

    expect(vi.mocked(client.chat)).toHaveBeenCalledTimes(2);
    expect(executeTool).toHaveBeenCalledOnce();
    // user + assistant-tool-call + tool-result + assistant-final = 4
    expect(persistMessage).toHaveBeenCalledTimes(4);
    expect(result.content).toBe("Done");
    expect(result.toolResults).toHaveLength(1);

    const emitCalls = vi.mocked(mockBus.emit).mock.calls.map((c) => c[0]);
    expect(emitCalls).toContain("tool.executed");
  });

  it("multi-round tool use", async () => {
    const config = createTestAgentConfig({
      tools: { allow: ["test-tool"], deny: [], maxToolCallsPerRound: 8 },
    });

    vi.mocked(getToolSchemas).mockReturnValue([
      { type: "function", function: { name: "test-tool", description: "Test", parameters: {} } } as ReturnType<typeof getToolSchemas>[number],
    ]);

    vi.mocked(executeTool).mockImplementation(async (call) => ({
      toolCallId: call.id,
      name: call.name,
      content: '{"ok":true}',
      durationMs: 42,
    }));

    const client = createMockInferenceClient([
      makeToolCallResponse([{ id: "tc-round-0", name: "test-tool", arguments: '{"step":1}' }]),
      makeToolCallResponse([{ id: "tc-round-1", name: "test-tool", arguments: '{"step":2}' }]),
      makeTextResponse("All done"),
    ]);

    const result = await runAgentLoop("user-1", "Run two tools", config, client);

    expect(vi.mocked(client.chat)).toHaveBeenCalledTimes(3);
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(result.toolResults).toHaveLength(2);
  });

  it("tool error recovery", async () => {
    const config = createTestAgentConfig({
      tools: { allow: ["test-tool"], deny: [], maxToolCallsPerRound: 8 },
    });

    vi.mocked(getToolSchemas).mockReturnValue([
      { type: "function", function: { name: "test-tool", description: "Test", parameters: {} } } as ReturnType<typeof getToolSchemas>[number],
    ]);

    vi.mocked(executeTool).mockResolvedValue({
      toolCallId: "tc-1",
      name: "test-tool",
      content: "Error occurred",
      durationMs: 10,
      error: "Something failed",
    });

    const client = createMockInferenceClient([
      makeToolCallResponse([{ id: "tc-1", name: "test-tool", arguments: '{}' }]),
      makeTextResponse("I handled it"),
    ]);

    // runAgentLoop must not throw — tool errors are returned as result.toolResults[*].error
    const result = await runAgentLoop("user-1", "Try the tool", config, client);

    expect(result.toolResults[0].error).toBe("Something failed");
    expect(result.content).toBe("I handled it");
  });

  it("max rounds limit", async () => {
    const config = createTestAgentConfig({
      tools: { allow: ["test-tool"], deny: [], maxToolCallsPerRound: 8 },
    });

    vi.mocked(getToolSchemas).mockReturnValue([
      { type: "function", function: { name: "test-tool", description: "Test", parameters: {} } } as ReturnType<typeof getToolSchemas>[number],
    ]);

    vi.mocked(executeTool).mockImplementation(async (call) => ({
      toolCallId: call.id,
      name: call.name,
      content: '{"ok":true}',
      durationMs: 10,
    }));

    // 8 tool call responses with no final text response, then a final answer once tools are cut off
    const client = createMockInferenceClient([
      makeToolCallResponse([{ id: "tc-round-0", name: "test-tool", arguments: '{"r":0}' }]),
      makeToolCallResponse([{ id: "tc-round-1", name: "test-tool", arguments: '{"r":1}' }]),
      makeToolCallResponse([{ id: "tc-round-2", name: "test-tool", arguments: '{"r":2}' }]),
      makeToolCallResponse([{ id: "tc-round-3", name: "test-tool", arguments: '{"r":3}' }]),
      makeToolCallResponse([{ id: "tc-round-4", name: "test-tool", arguments: '{"r":4}' }]),
      makeToolCallResponse([{ id: "tc-round-5", name: "test-tool", arguments: '{"r":5}' }]),
      makeToolCallResponse([{ id: "tc-round-6", name: "test-tool", arguments: '{"r":6}' }]),
      makeToolCallResponse([{ id: "tc-round-7", name: "test-tool", arguments: '{"r":7}' }]),
      makeTextResponse("I hit the processing limit and am returning the best answer I can."),
    ]);

    const result = await runAgentLoop("user-1", "Infinite tools", config, client);

    expect(vi.mocked(client.chat)).toHaveBeenCalledTimes(9);
    expect(result.content).toContain("processing limit");
    expect(executeTool).toHaveBeenCalledTimes(8);
  });

  it("event emission", async () => {
    const config = createTestAgentConfig();
    const client = createMockInferenceClient([makeTextResponse("Test")]);

    await runAgentLoop("user-1", "Emit events", config, client);

    const emitCalls = vi.mocked(mockBus.emit).mock.calls;
    const eventNames = emitCalls.map((c) => c[0] as string);

    // Verify key events are emitted in order
    const startedIdx = eventNames.indexOf("agent.started");
    const inferenceIdx = eventNames.indexOf("inference.request");
    const completedIdx = eventNames.indexOf("agent.completed");
    const metricsIdx = eventNames.indexOf("agent.metrics");

    expect(startedIdx).toBeGreaterThanOrEqual(0);
    expect(inferenceIdx).toBeGreaterThan(startedIdx);
    expect(completedIdx).toBeGreaterThan(inferenceIdx);
    expect(metricsIdx).toBeGreaterThan(completedIdx);

    // Verify "agent.started" payload shape
    const startedPayload = emitCalls[startedIdx][1] as Record<string, unknown>;
    expect(startedPayload).toHaveProperty("uid", "user-1");
    expect(startedPayload).toHaveProperty("agentId", config.id);
    expect(startedPayload).toHaveProperty("sessionId", "sess-1");
    expect(startedPayload).toHaveProperty("traceId");
    expect(startedPayload).toHaveProperty("timestamp");

    // Verify "agent.completed" payload contains the response content
    const completedPayload = emitCalls[completedIdx][1] as Record<string, unknown>;
    expect(completedPayload).toHaveProperty("content", "Test");
  });
});
