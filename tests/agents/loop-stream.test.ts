import { vi, describe, it, expect, beforeEach } from "vitest";

// vi.hoisted runs before vi.mock factories — makes objects available in closures
const { mockPool, mockBus } = vi.hoisted(() => {
  const pool = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    connect: vi.fn().mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }),
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

// ── Module mocks ──────────────────────────────────────────────────────

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
  assembleContext: vi.fn().mockImplementation(
    async (_uid: string, _config: unknown, messages: unknown[]) => ({
      messages: (messages as Array<{ role: string; content: string }>).map((m) => ({
        role: m.role,
        content: m.content,
      })),
      estimatedTokens: 200,
    }),
  ),
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
  emitAgentStreaming: vi.fn(),
  emitToolCallStart: vi.fn(),
  emitToolCallEnd: vi.fn(),
  emitAgentCompleted: vi.fn(),
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

vi.mock("../../src/utils/ssrf-guard.js", () => ({
  isBlockedUrl: vi.fn().mockResolvedValue(false),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────

import { runAgentLoopStream } from "../../src/agents/loop-stream.js";
import type { AgentStreamEvent } from "../../src/agents/stream-types.js";
import {
  createTestAgentConfig,
  makeTextResponse,
  makeToolCallResponse,
  createMockInferenceClient,
  createMockSession,
  createMockEventBus,
  mockPersistMessage,
  resetMsgCounter,
} from "./fixtures.js";
import { resolveSession, persistMessage } from "../../src/sessions/store.js";
import { getToolSchemas, executeTool } from "../../src/tools/index.js";

// ── Helper ────────────────────────────────────────────────────────────

async function collectEvents(
  gen: AsyncGenerator<AgentStreamEvent>,
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

// ── Suite ─────────────────────────────────────────────────────────────

describe("runAgentLoopStream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMsgCounter();
    vi.mocked(resolveSession).mockResolvedValue(createMockSession("sess-1"));
    vi.mocked(persistMessage).mockImplementation(
      async (_uid: string, _sid: string, msg: unknown) =>
        mockPersistMessage(_uid, _sid, msg as Parameters<typeof mockPersistMessage>[2]),
    );
  });

  // ── Test 8 ───────────────────────────────────────────────────────────

  it("streaming basic — text response yields correct events", async () => {
    const config = createTestAgentConfig();
    const client = createMockInferenceClient([makeTextResponse("Hello world!")]);

    const events = await collectEvents(
      runAgentLoopStream("test-user", "Hi", config, client),
    );

    const types = events.map((e) => e.type);

    // Required event types appear in order
    const sessionResolvedIdx = types.indexOf("session_resolved");
    const inferenceStartIdx = types.indexOf("inference_start");
    const firstDeltaIdx = types.indexOf("stream_delta");
    const inferenceDoneIdx = types.indexOf("inference_done");
    const completedIdx = types.indexOf("completed");

    expect(sessionResolvedIdx).toBeGreaterThanOrEqual(0);
    expect(inferenceStartIdx).toBeGreaterThan(sessionResolvedIdx);
    expect(firstDeltaIdx).toBeGreaterThan(inferenceStartIdx);
    expect(inferenceDoneIdx).toBeGreaterThan(firstDeltaIdx);
    expect(completedIdx).toBeGreaterThan(inferenceDoneIdx);

    // session_resolved carries correct data
    const sessionResolvedEvent = events[sessionResolvedIdx];
    expect(sessionResolvedEvent).toMatchObject({
      type: "session_resolved",
      sessionId: "sess-1",
      isNew: true,
    });

    // All stream_delta chunks reassemble to full content
    const deltaEvents = events.filter(
      (e): e is Extract<AgentStreamEvent, { type: "stream_delta" }> =>
        e.type === "stream_delta",
    );
    expect(deltaEvents.length).toBeGreaterThanOrEqual(1);
    const reassembled = deltaEvents.map((e) => e.content).join("");
    expect(reassembled).toBe("Hello world!");

    // completed event
    const completedEvent = events[completedIdx];
    expect(completedEvent).toMatchObject({
      type: "completed",
      content: "Hello world!",
      sessionId: "sess-1",
    });

    // inference_done event
    const inferenceDoneEvent = events[inferenceDoneIdx];
    expect(inferenceDoneEvent).toMatchObject({
      type: "inference_done",
      round: 0,
      finishReason: "stop",
    });
  });

  // ── Test 9 ───────────────────────────────────────────────────────────

  it("streaming with tools — tool calls mid-stream", async () => {
    const config = createTestAgentConfig({
      tools: { allow: ["test-tool"], deny: [], maxToolCallsPerRound: 8 },
    });

    const client = createMockInferenceClient([
      makeToolCallResponse([
        { id: "tc-1", name: "test-tool", arguments: '{"q":"test"}' },
      ]),
      makeTextResponse("Done!"),
    ]);

    vi.mocked(getToolSchemas).mockReturnValue([
      {
        type: "function",
        function: { name: "test-tool", description: "Test", parameters: {} },
      },
    ]);

    vi.mocked(executeTool).mockResolvedValue({
      toolCallId: "tc-1",
      name: "test-tool",
      content: '{"ok":true}',
      durationMs: 42,
    });

    const events = await collectEvents(
      runAgentLoopStream("test-user", "Run tool", config, client),
    );

    const types = events.map((e) => e.type);

    // session_resolved first
    expect(types[0]).toBe("session_resolved");

    // inference_start for round 0
    const inferenceStart0Idx = types.indexOf("inference_start");
    expect(inferenceStart0Idx).toBeGreaterThanOrEqual(0);
    const inferenceStart0 = events[inferenceStart0Idx] as Extract<
      AgentStreamEvent,
      { type: "inference_start" }
    >;
    expect(inferenceStart0.round).toBe(0);

    // tool_call_complete present
    const toolCallCompleteIdx = types.indexOf("tool_call_complete");
    expect(toolCallCompleteIdx).toBeGreaterThan(inferenceStart0Idx);

    // tool_result present with correct data
    const toolResultIdx = types.indexOf("tool_result");
    expect(toolResultIdx).toBeGreaterThan(toolCallCompleteIdx);
    const toolResultEvent = events[toolResultIdx] as Extract<
      AgentStreamEvent,
      { type: "tool_result" }
    >;
    expect(toolResultEvent.name).toBe("test-tool");
    expect(toolResultEvent.content).toBe('{"ok":true}');

    // inference_start for round 1
    const inferenceStart1Idx = types.indexOf("inference_start", inferenceStart0Idx + 1);
    expect(inferenceStart1Idx).toBeGreaterThan(toolResultIdx);
    const inferenceStart1 = events[inferenceStart1Idx] as Extract<
      AgentStreamEvent,
      { type: "inference_start" }
    >;
    expect(inferenceStart1.round).toBe(1);

    // stream_delta(s) in round 1
    const firstDeltaAfterRound1 = types.findIndex(
      (t, i) => t === "stream_delta" && i > inferenceStart1Idx,
    );
    expect(firstDeltaAfterRound1).toBeGreaterThan(inferenceStart1Idx);

    // inference_done after round 1 deltas
    const inferenceDoneIdx = types.indexOf("inference_done", firstDeltaAfterRound1);
    expect(inferenceDoneIdx).toBeGreaterThan(firstDeltaAfterRound1);

    // completed last with "Done!" content
    const completedIdx = types.lastIndexOf("completed");
    expect(completedIdx).toBeGreaterThan(inferenceDoneIdx);
    const completedEvent = events[completedIdx] as Extract<
      AgentStreamEvent,
      { type: "completed" }
    >;
    expect(completedEvent.content).toBe("Done!");

    // executeTool called exactly once
    expect(vi.mocked(executeTool)).toHaveBeenCalledTimes(1);
  });

  // ── Test 10 ──────────────────────────────────────────────────────────

  it("streaming session info — isNew flag propagated", async () => {
    const config = createTestAgentConfig();

    // First call — brand new session
    vi.mocked(resolveSession).mockResolvedValueOnce(createMockSession("sess-1"));
    const client1 = createMockInferenceClient([makeTextResponse("First")]);
    const events1 = await collectEvents(
      runAgentLoopStream("test-user", "Hello", config, client1),
    );
    const sessionResolved1 = events1.find(
      (e): e is Extract<AgentStreamEvent, { type: "session_resolved" }> =>
        e.type === "session_resolved",
    );
    expect(sessionResolved1).toBeDefined();
    expect(sessionResolved1!.isNew).toBe(true);

    // Second call — returning session (isNew: false)
    const returningSession = { ...createMockSession("sess-1"), isNew: false };
    vi.mocked(resolveSession).mockResolvedValueOnce(returningSession);
    const client2 = createMockInferenceClient([makeTextResponse("Second")]);
    const events2 = await collectEvents(
      runAgentLoopStream("test-user", "Hello again", config, client2),
    );
    const sessionResolved2 = events2.find(
      (e): e is Extract<AgentStreamEvent, { type: "session_resolved" }> =>
        e.type === "session_resolved",
    );
    expect(sessionResolved2).toBeDefined();
    expect(sessionResolved2!.isNew).toBe(false);
  });
});
