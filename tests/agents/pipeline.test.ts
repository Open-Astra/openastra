import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Tests for src/agents/pipeline.ts ────────────────────────────────

const { mockGetAgentConfig } = vi.hoisted(() => {
  return {
    mockGetAgentConfig: vi.fn(),
  };
});

vi.mock("../../src/config/agents.js", () => ({
  getAgentConfig: mockGetAgentConfig,
}));

vi.mock("../../src/utils/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { runPipeline } from "../../src/agents/pipeline.js";
import type { AgentConfig } from "../../src/agents/types.js";
import type { InferenceClient } from "../../src/inference/types.js";
import type { ResolveClientFn } from "../../src/agents/pipeline.js";

// ── Helpers ───────────────────────────────────────────────────────────

function makeAgentConfig(id: string, systemPrompt = "You are helpful."): AgentConfig {
  return {
    id,
    displayName: `Agent ${id}`,
    tier: "free",
    model: {
      provider: "openai",
      modelId: "gpt-4o",
      maxContextTokens: 8000,
      maxOutputTokens: 2048,
      temperature: 0.7,
    },
    systemPromptTemplate: systemPrompt,
    tools: { allow: [], deny: [], maxToolCallsPerRound: 8 },
    skills: [],
    session: { dailyResetHour: 4, idleTimeoutMinutes: 120, maxContextMessages: 50 },
    spawn: { enabled: false, allowedTargets: [], maxDepth: 2 },
    fileAccess: { restricted: true, allowedPaths: [] },
  };
}

function makeClient(responseText: string): InferenceClient {
  return {
    chat: vi.fn().mockResolvedValue({
      content: responseText,
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    }),
    chatStream: vi.fn(),
  } as unknown as InferenceClient;
}

describe("runPipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes a single-stage pipeline and returns the output", async () => {
    const agentConfig = makeAgentConfig("agent-a");
    mockGetAgentConfig.mockReturnValue(agentConfig);

    const client = makeClient("Stage A output");
    const resolveClient: ResolveClientFn = () => client;

    const result = await runPipeline(
      "initial input",
      [{ agentId: "agent-a" }],
      resolveClient,
      { uid: "user-1" },
    );

    expect(result.finalOutput).toBe("Stage A output");
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0].agentId).toBe("agent-a");
    expect(result.stages[0].input).toBe("initial input");
    expect(result.stages[0].output).toBe("Stage A output");
  });

  it("output of stage N flows as input to stage N+1", async () => {
    const agentA = makeAgentConfig("agent-a");
    const agentB = makeAgentConfig("agent-b");
    mockGetAgentConfig.mockImplementation((id: string) => {
      if (id === "agent-a") return agentA;
      return agentB;
    });

    const clientA = makeClient("output from A");
    const clientB = makeClient("output from B");
    const resolveClient: ResolveClientFn = (config) => {
      if (config.id === "agent-a") return clientA;
      return clientB;
    };

    const result = await runPipeline(
      "initial",
      [{ agentId: "agent-a" }, { agentId: "agent-b" }],
      resolveClient,
      { uid: "user-1" },
    );

    expect(result.stages).toHaveLength(2);
    // Stage B's input should be stage A's output
    expect(result.stages[1].input).toBe("output from A");
    expect(result.finalOutput).toBe("output from B");
  });

  it("pipeline result includes all stage outputs and a pipelineId", async () => {
    const agentA = makeAgentConfig("agent-a");
    const agentB = makeAgentConfig("agent-b");
    const agentC = makeAgentConfig("agent-c");
    mockGetAgentConfig.mockImplementation((id: string) => {
      if (id === "agent-a") return agentA;
      if (id === "agent-b") return agentB;
      return agentC;
    });

    const resolveClient: ResolveClientFn = (config) =>
      makeClient(`output from ${config.id}`);

    const result = await runPipeline(
      "start",
      [{ agentId: "agent-a" }, { agentId: "agent-b" }, { agentId: "agent-c" }],
      resolveClient,
      { uid: "user-1" },
    );

    expect(result.pipelineId).toBeDefined();
    expect(typeof result.pipelineId).toBe("string");
    expect(result.stages).toHaveLength(3);
    expect(result.stages.map((s) => s.agentId)).toEqual(["agent-a", "agent-b", "agent-c"]);
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("stage failure (inference error) halts pipeline with thrown error", async () => {
    const agentConfig = makeAgentConfig("agent-failing");
    mockGetAgentConfig.mockReturnValue(agentConfig);

    const failingClient = {
      chat: vi.fn().mockRejectedValue(new Error("Provider unavailable")),
      chatStream: vi.fn(),
    } as unknown as InferenceClient;

    const resolveClient: ResolveClientFn = () => failingClient;

    await expect(
      runPipeline(
        "input",
        [{ agentId: "agent-failing" }],
        resolveClient,
        { uid: "user-1" },
      ),
    ).rejects.toThrow("Provider unavailable");
  });

  it("empty pipeline (zero stages) throws an error", async () => {
    const resolveClient: ResolveClientFn = () => makeClient("never called");

    await expect(
      runPipeline("input", [], resolveClient, { uid: "user-1" }),
    ).rejects.toThrow("Pipeline must have at least one stage");
  });

  it("systemPromptSuffix is appended to the agent system prompt", async () => {
    const agentConfig = makeAgentConfig("agent-a", "Base prompt.");
    mockGetAgentConfig.mockReturnValue(agentConfig);

    const client = makeClient("response");
    const resolveClient: ResolveClientFn = () => client;

    await runPipeline(
      "input",
      [{ agentId: "agent-a", systemPromptSuffix: "Additional instructions." }],
      resolveClient,
      { uid: "user-1" },
    );

    const chatCall = (client.chat as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const systemMessage = chatCall.messages.find((m: { role: string }) => m.role === "system");
    expect(systemMessage.content).toContain("Base prompt.");
    expect(systemMessage.content).toContain("Additional instructions.");
  });

  it("stage durationMs is a non-negative number", async () => {
    const agentConfig = makeAgentConfig("agent-a");
    mockGetAgentConfig.mockReturnValue(agentConfig);

    const resolveClient: ResolveClientFn = () => makeClient("output");

    const result = await runPipeline(
      "input",
      [{ agentId: "agent-a" }],
      resolveClient,
      { uid: "user-1" },
    );

    expect(result.stages[0].durationMs).toBeGreaterThanOrEqual(0);
  });
});
