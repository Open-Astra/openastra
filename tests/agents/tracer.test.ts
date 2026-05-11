import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Tests for src/agents/tracer.ts ──────────────────────────────────

const { mockPool } = vi.hoisted(() => {
  return {
    mockPool: {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      connect: vi.fn(),
      end: vi.fn(),
      on: vi.fn(),
      totalCount: 1,
      idleCount: 1,
      waitingCount: 0,
    },
  };
});

vi.mock("../../src/config/postgres.js", () => ({
  getPool: () => mockPool,
}));

vi.mock("../../src/utils/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { AgentTracer } from "../../src/agents/tracer.js";

describe("AgentTracer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("constructor accepts all trace options without throwing", () => {
    expect(() => new AgentTracer({
      traceId: "trace-1",
      sessionId: "session-1",
      agentId: "agent-1",
      uid: "user-1",
      workspaceId: "ws-1",
    })).not.toThrow();
  });

  it("start() records begin time (verified by finish inserting positive durationMs)", async () => {
    const tracer = new AgentTracer({
      traceId: "trace-2",
      sessionId: "session-2",
      agentId: "agent-2",
      uid: "user-2",
    });

    tracer.start();
    // Small delay to ensure non-zero duration
    await new Promise(r => setTimeout(r, 5));
    tracer.finish("completed");

    // Wait for the fire-and-forget query
    await new Promise(r => setTimeout(r, 10));

    expect(mockPool.query).toHaveBeenCalledOnce();
    const [, params] = mockPool.query.mock.calls[0];
    const durationMs = params[7]; // 8th param is duration_ms
    expect(durationMs).toBeGreaterThan(0);
  });

  it("addToolCall accumulates tool call records in the trace", () => {
    const tracer = new AgentTracer({
      traceId: "trace-3",
      sessionId: "session-3",
      agentId: "agent-3",
      uid: "user-3",
    });

    tracer.start();
    tracer.addToolCall("web-search", 120);
    tracer.addToolCall("read-file", 45, "Permission denied");
    tracer.finish("completed");

    const [, params] = mockPool.query.mock.calls[0];
    const toolCallsJson = params[11]; // $12 = tool_calls
    const toolCalls = JSON.parse(toolCallsJson);
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].toolName).toBe("web-search");
    expect(toolCalls[0].durationMs).toBe(120);
    expect(toolCalls[1].toolName).toBe("read-file");
    expect(toolCalls[1].error).toBe("Permission denied");
  });

  it("setTokens stores prompt, completion, and total token counts", () => {
    const tracer = new AgentTracer({
      traceId: "trace-4",
      sessionId: "session-4",
      agentId: "agent-4",
      uid: "user-4",
    });

    tracer.start();
    tracer.setTokens(500, 300, 800);
    tracer.finish("completed");

    const [, params] = mockPool.query.mock.calls[0];
    expect(params[8]).toBe(500);  // prompt_tokens
    expect(params[9]).toBe(300);  // completion_tokens
    expect(params[10]).toBe(800); // total_tokens
  });

  it("finish() inserts trace row with correct shape and final_status", () => {
    const tracer = new AgentTracer({
      traceId: "trace-5",
      sessionId: "sess-5",
      agentId: "agent-5",
      uid: "user-5",
      workspaceId: "ws-5",
    });

    tracer.start();
    tracer.finish("error", "Something went wrong");

    expect(mockPool.query).toHaveBeenCalledOnce();
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO agent_traces");
    expect(params[0]).toBe("trace-5");      // id
    expect(params[1]).toBe("sess-5");       // session_id
    expect(params[2]).toBe("agent-5");      // agent_id
    expect(params[3]).toBe("ws-5");         // workspace_id
    expect(params[4]).toBe("user-5");       // uid
    expect(params[13]).toBe("error");       // final_status
    expect(params[14]).toBe("Something went wrong"); // error_message
  });

  it("finish() does nothing when start() was never called", () => {
    const tracer = new AgentTracer({
      traceId: "trace-6",
      sessionId: "sess-6",
      agentId: "agent-6",
      uid: "user-6",
    });

    // No start() call
    tracer.finish("completed");

    expect(mockPool.query).not.toHaveBeenCalled();
  });
});
