import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────
const { mockPool, mockBus } = vi.hoisted(() => {
  const pool = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: vi.fn(),
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
    publish: vi.fn(),
  };
  return { mockPool: pool, mockBus: bus };
});

vi.mock("../../src/config/postgres.js", () => ({
  getPool: () => mockPool,
}));

vi.mock("../../src/config/agents.js", () => ({
  getAgentConfig: vi.fn(),
}));

vi.mock("../../src/agents/loop.js", () => ({
  runAgentLoop: vi.fn(),
}));

vi.mock("../../src/agents/audit.js", () => ({
  logAgentAction: vi.fn().mockResolvedValue("audit-id"),
}));

vi.mock("../../src/agents/pubsub.js", () => {
  // PubSubBus class with publish method
  class PubSubBus {
    publish = vi.fn();
  }
  const instance = new PubSubBus();
  return {
    getBus: vi.fn().mockReturnValue(instance),
    PubSubBus,
  };
});

vi.mock("../../src/skills/registry.js", () => ({
  getSkillToolNames: vi.fn().mockReturnValue([]),
}));

vi.mock("../../src/events/index.js", () => ({
  getEventBus: vi.fn().mockReturnValue(mockBus),
}));

import { spawnAgent, SpawnError } from "../../src/agents/spawn.js";
import { getAgentConfig } from "../../src/config/agents.js";
import { runAgentLoop } from "../../src/agents/loop.js";
import { getSkillToolNames } from "../../src/skills/registry.js";
import type { AgentConfig } from "../../src/agents/types.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "test-agent",
    displayName: "Test Agent",
    tier: "free",
    model: {
      provider: "openai",
      modelId: "gpt-4o-mini",
      maxContextTokens: 8192,
      maxOutputTokens: 1024,
      temperature: 0.7,
    },
    systemPromptTemplate: "You are a test agent.",
    tools: { allow: ["tool-a", "tool-b"], deny: [], maxToolCallsPerRound: 8 },
    skills: [],
    session: { dailyResetHour: 4, idleTimeoutMinutes: 120, maxContextMessages: 50 },
    spawn: { enabled: true, allowedTargets: ["target-agent"], maxDepth: 2 },
    fileAccess: { restricted: true, allowedPaths: [] },
    ...overrides,
  } as AgentConfig;
}

function makeInferenceClient() {
  return {
    chat: vi.fn(),
    chatStream: vi.fn(),
  };
}

function makeAgentResponse() {
  return {
    content: "Sub-agent completed task",
    toolResults: [],
    sessionId: "sub-session-1",
    tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

// ── Tests ────────────────────────────────────────────────────────────

describe("spawnAgent — validation", () => {
  it("throws SpawnError with SPAWN_DISABLED when spawn.enabled=false", async () => {
    const parent = makeAgentConfig({ spawn: { enabled: false, allowedTargets: ["target-agent"], maxDepth: 2 } });
    const client = makeInferenceClient();

    await expect(
      spawnAgent(parent, "target-agent", "do task", "user-1", client),
    ).rejects.toThrow(SpawnError);

    await expect(
      spawnAgent(parent, "target-agent", "do task", "user-1", client),
    ).rejects.toMatchObject({ code: "SPAWN_DISABLED" });
  });

  it("throws SpawnError with TARGET_NOT_ALLOWED when target not in allowedTargets", async () => {
    const parent = makeAgentConfig({
      spawn: { enabled: true, allowedTargets: ["allowed-agent"], maxDepth: 2 },
    });
    const client = makeInferenceClient();

    await expect(
      spawnAgent(parent, "forbidden-agent", "do task", "user-1", client),
    ).rejects.toMatchObject({ code: "TARGET_NOT_ALLOWED" });
  });

  it("throws SpawnError with DEPTH_EXCEEDED when depth >= maxDepth", async () => {
    const parent = makeAgentConfig({
      spawn: { enabled: true, allowedTargets: ["target-agent"], maxDepth: 2 },
    });
    const client = makeInferenceClient();

    await expect(
      spawnAgent(parent, "target-agent", "do task", "user-1", client, 2),
    ).rejects.toMatchObject({ code: "DEPTH_EXCEEDED" });
  });

  it("throws SpawnError with TARGET_NOT_FOUND when getAgentConfig throws", async () => {
    const parent = makeAgentConfig();
    vi.mocked(getAgentConfig).mockImplementation(() => {
      throw new Error("Unknown agent: target-agent");
    });
    const client = makeInferenceClient();

    await expect(
      spawnAgent(parent, "target-agent", "do task", "user-1", client),
    ).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });
  });

  it("rejects all targets when allowedTargets is empty (even if spawn.enabled=true)", async () => {
    const parent = makeAgentConfig({
      spawn: { enabled: true, allowedTargets: [], maxDepth: 2 },
    });
    const client = makeInferenceClient();

    await expect(
      spawnAgent(parent, "any-agent", "do task", "user-1", client),
    ).rejects.toMatchObject({ code: "TARGET_NOT_ALLOWED" });
  });
});

describe("spawnAgent — tool intersection (no privilege escalation)", () => {
  it("restricts sub-agent tools to intersection of parent and target allow lists", async () => {
    const parent = makeAgentConfig({
      tools: { allow: ["tool-a", "tool-b"], deny: [], maxToolCallsPerRound: 8 },
      spawn: { enabled: true, allowedTargets: ["target-agent"], maxDepth: 2 },
    });

    const target = makeAgentConfig({
      id: "target-agent",
      tools: { allow: ["tool-b", "tool-c"], deny: [], maxToolCallsPerRound: 8 }, // tool-c not in parent
      spawn: { enabled: false, allowedTargets: [], maxDepth: 2 },
    });

    vi.mocked(getAgentConfig).mockReturnValue(target);
    vi.mocked(runAgentLoop).mockResolvedValue(makeAgentResponse() as ReturnType<typeof runAgentLoop> extends Promise<infer T> ? T : never);

    const client = makeInferenceClient();
    await spawnAgent(parent, "target-agent", "task", "user-1", client);

    // The restrictedConfig passed to runAgentLoop should only have tool-b (intersection)
    const loopCall = vi.mocked(runAgentLoop).mock.calls[0]!;
    const restrictedConfig = loopCall[2] as AgentConfig;
    expect(restrictedConfig.tools.allow).toContain("tool-b");
    expect(restrictedConfig.tools.allow).not.toContain("tool-a"); // not in target
    expect(restrictedConfig.tools.allow).not.toContain("tool-c"); // not in parent
  });

  it("sub-agent inherits no tools when there is no intersection", async () => {
    const parent = makeAgentConfig({
      tools: { allow: ["tool-x"], deny: [], maxToolCallsPerRound: 8 },
      spawn: { enabled: true, allowedTargets: ["target-agent"], maxDepth: 2 },
    });

    const target = makeAgentConfig({
      id: "target-agent",
      tools: { allow: ["tool-y"], deny: [], maxToolCallsPerRound: 8 },
      spawn: { enabled: false, allowedTargets: [], maxDepth: 2 },
    });

    vi.mocked(getAgentConfig).mockReturnValue(target);
    vi.mocked(runAgentLoop).mockResolvedValue(makeAgentResponse() as ReturnType<typeof runAgentLoop> extends Promise<infer T> ? T : never);

    const client = makeInferenceClient();
    await spawnAgent(parent, "target-agent", "task", "user-1", client);

    const loopCall = vi.mocked(runAgentLoop).mock.calls[0]!;
    const restrictedConfig = loopCall[2] as AgentConfig;
    expect(restrictedConfig.tools.allow).toHaveLength(0);
  });
});

describe("spawnAgent — successful spawn", () => {
  it("returns SpawnResult with correct shape on success", async () => {
    const parent = makeAgentConfig();
    const target = makeAgentConfig({
      id: "target-agent",
      tools: { allow: ["tool-a"], deny: [], maxToolCallsPerRound: 8 },
      spawn: { enabled: false, allowedTargets: [], maxDepth: 2 },
    });

    vi.mocked(getAgentConfig).mockReturnValue(target);
    vi.mocked(runAgentLoop).mockResolvedValue(makeAgentResponse() as ReturnType<typeof runAgentLoop> extends Promise<infer T> ? T : never);

    const client = makeInferenceClient();
    const result = await spawnAgent(parent, "target-agent", "analyze this", "user-1", client);

    expect(result.success).toBe(true);
    expect(result.targetAgentId).toBe("target-agent");
    expect(result.content).toBe("Sub-agent completed task");
    expect(result.sessionId).toBe("sub-session-1");
    expect(result.taskId).toBeDefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("tracks spawn chain: passes correct depth to runAgentLoop session key", async () => {
    const parent = makeAgentConfig();
    const target = makeAgentConfig({
      id: "target-agent",
      tools: { allow: ["tool-a"], deny: [], maxToolCallsPerRound: 8 },
      spawn: { enabled: false, allowedTargets: [], maxDepth: 2 },
    });

    vi.mocked(getAgentConfig).mockReturnValue(target);
    vi.mocked(runAgentLoop).mockResolvedValue(makeAgentResponse() as ReturnType<typeof runAgentLoop> extends Promise<infer T> ? T : never);

    const client = makeInferenceClient();
    await spawnAgent(parent, "target-agent", "task", "user-1", client, 1);

    const loopCall = vi.mocked(runAgentLoop).mock.calls[0]!;
    // uid is first arg
    expect(loopCall[0]).toBe("user-1");
    // task is second arg
    expect(loopCall[1]).toBe("task");
    // session key is last arg — surface should be "prop"
    const sessionKey = loopCall[4] as { surface: string; uid: string };
    expect(sessionKey.surface).toBe("prop");
    expect(sessionKey.uid).toBe("user-1");
  });

  it("throws EXECUTION_FAILED SpawnError if runAgentLoop throws", async () => {
    const parent = makeAgentConfig();
    const target = makeAgentConfig({
      id: "target-agent",
      tools: { allow: ["tool-a"], deny: [], maxToolCallsPerRound: 8 },
      spawn: { enabled: false, allowedTargets: [], maxDepth: 2 },
    });

    vi.mocked(getAgentConfig).mockReturnValue(target);
    vi.mocked(runAgentLoop).mockRejectedValue(new Error("Inference timeout"));

    const client = makeInferenceClient();
    await expect(
      spawnAgent(parent, "target-agent", "task", "user-1", client),
    ).rejects.toMatchObject({ code: "EXECUTION_FAILED" });
  });
});

describe("spawnAgent — skills restriction", () => {
  it("filters out skills whose tools are not in parent allow set", async () => {
    const parent = makeAgentConfig({
      tools: { allow: ["tool-a"], deny: [], maxToolCallsPerRound: 8 },
      spawn: { enabled: true, allowedTargets: ["target-agent"], maxDepth: 2 },
    });

    const target = makeAgentConfig({
      id: "target-agent",
      skills: ["skill-with-restricted-tool", "skill-with-allowed-tool"],
      tools: { allow: ["tool-a", "tool-z"], deny: [], maxToolCallsPerRound: 8 },
      spawn: { enabled: false, allowedTargets: [], maxDepth: 2 },
    });

    vi.mocked(getAgentConfig).mockReturnValue(target);
    vi.mocked(runAgentLoop).mockResolvedValue(makeAgentResponse() as ReturnType<typeof runAgentLoop> extends Promise<infer T> ? T : never);

    // skill-with-restricted-tool uses tool-z (not in parent), skill-with-allowed-tool uses tool-a
    vi.mocked(getSkillToolNames).mockImplementation((skillIds: string[]) => {
      if (skillIds.includes("skill-with-restricted-tool")) return ["tool-z"];
      if (skillIds.includes("skill-with-allowed-tool")) return ["tool-a"];
      return [];
    });

    const client = makeInferenceClient();
    await spawnAgent(parent, "target-agent", "task", "user-1", client);

    const loopCall = vi.mocked(runAgentLoop).mock.calls[0]!;
    const restrictedConfig = loopCall[2] as AgentConfig;
    expect(restrictedConfig.skills).not.toContain("skill-with-restricted-tool");
    expect(restrictedConfig.skills).toContain("skill-with-allowed-tool");
  });
});
