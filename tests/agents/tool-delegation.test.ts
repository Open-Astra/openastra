import { vi, describe, it, expect, beforeEach } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";

const { mockFindAgentsWithTool, mockExecuteTool, mockEmit } = vi.hoisted(() => {
  return {
    mockFindAgentsWithTool: vi.fn(),
    mockExecuteTool: vi.fn(),
    mockEmit: vi.fn(),
  };
});

vi.mock("../../src/agents/capability-negotiator.js", () => ({
  findAgentsWithTool: (...args: unknown[]) => mockFindAgentsWithTool(...args),
}));

vi.mock("../../src/tools/registry.js", () => ({
  executeTool: (...args: unknown[]) => mockExecuteTool(...args),
}));

vi.mock("../../src/events/index.js", () => ({
  getEventBus: () => ({
    emit: mockEmit,
  }),
}));

import { delegateToolCall, validateDelegationTarget } from "../../src/agents/tool-delegation.js";

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    uid: "user-1",
    agentId: "agent-a",
    sessionId: "session-1",
    metadata: {
      delegationTrail: ["agent-root"],
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("validateDelegationTarget", () => {
  it("rejects delegation back to the current agent", () => {
    const result = validateDelegationTarget("agent-a", makeCtx(), "agent-a");

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("loop");
  });

  it("rejects delegation to an agent already in the trail", () => {
    const result = validateDelegationTarget("agent-root", makeCtx(), "agent-a");

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("delegation trail");
  });
});

describe("delegateToolCall", () => {
  it("skips agents already in the trail and picks a safe candidate", async () => {
    mockFindAgentsWithTool.mockReturnValue(["agent-a", "agent-root", "agent-b"]);
    mockExecuteTool.mockResolvedValue({
      toolCallId: "tool-call-1",
      name: "web_search",
      content: JSON.stringify({ ok: true }),
      durationMs: 25,
    });

    const result = await delegateToolCall(
      {
        requestId: "request-1",
        fromAgentId: "agent-a",
        fromRole: "researcher",
        toolName: "web_search",
        toolArgs: { query: "openastra" },
      },
      makeCtx({
        agentId: "agent-a",
        metadata: { delegationTrail: ["agent-root"] },
      }),
    );

    expect(result.success).toBe(true);
    expect(result.delegatedTo).toBe("agent-b");
    expect(mockExecuteTool).toHaveBeenCalledOnce();

    const [, targetCtx, allowedTools] = mockExecuteTool.mock.calls[0]!;
    expect((targetCtx as ToolContext).agentId).toBe("agent-b");
    expect((targetCtx as ToolContext).metadata).toMatchObject({
      delegatedFrom: "agent-a",
      delegationTrail: ["agent-root", "agent-a", "agent-b"],
    });
    expect((allowedTools as Set<string>).has("web_search")).toBe(true);
  });

  it("rejects delegating the delegation tool itself", async () => {
    const result = await delegateToolCall(
      {
        requestId: "request-2",
        fromAgentId: "agent-a",
        fromRole: "researcher",
        toolName: "delegate_tool_call",
        toolArgs: { tool_name: "web_search", tool_args: {} },
      },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("not allowed");
    expect(mockExecuteTool).not.toHaveBeenCalled();
  });
});
