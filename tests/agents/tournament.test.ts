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

// Mock config/agents before the module under test is imported
const mockAgentRegistry = new Map<string, unknown>();

vi.mock("../../src/config/postgres.js", () => ({
  getPool: () => mockPool,
}));

vi.mock("../../src/config/agents.js", () => ({
  getAgentConfig: vi.fn((id: string) => {
    const cfg = mockAgentRegistry.get(id);
    if (!cfg) throw new Error(`Unknown agent: ${id}`);
    return cfg;
  }),
}));

vi.mock("../../src/utils/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    dim: vi.fn(),
  }),
}));

import { runTournament, type AgentRanking, type TournamentResult } from "../../src/agents/tournament.js";
import type { InferenceClient } from "../../src/inference/types.js";
import type { AgentConfig } from "../../src/agents/types.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeAgentConfig(id: string): AgentConfig {
  return {
    id,
    name: `Agent ${id}`,
    description: "",
    systemPromptTemplate: `You are ${id}`,
    model: {
      provider: "openai" as const,
      modelId: "gpt-4o",
      temperature: 0.7,
      maxOutputTokens: 512,
    },
    tools: { allow: [], deny: [], maxToolCallsPerRound: 5 },
    session: { idleTimeoutMinutes: 30, dailyResetHour: 0 },
    spawn: { enabled: false, allowedTargets: [], maxDepth: 2 },
    memory: { enabled: false, autoSave: false },
    skills: [],
    tags: [],
  } as unknown as AgentConfig;
}

function makeClient(response: string): InferenceClient {
  return {
    chat: vi.fn().mockResolvedValue({
      content: response,
      toolCalls: [],
      usage: { prompt: 10, completion: 20, total: 30 },
      finishReason: "stop",
    }),
    chatStream: vi.fn(),
  };
}

function makeFailingClient(errorMsg: string): InferenceClient {
  return {
    chat: vi.fn().mockRejectedValue(new Error(errorMsg)),
    chatStream: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAgentRegistry.clear();
  mockPool.query.mockResolvedValue({ rows: [] });
});

// ── Tests ────────────────────────────────────────────────────────────

describe("runTournament", () => {
  it("two agents compared — winner is the one with higher score", async () => {
    const agentA = makeAgentConfig("agent-a");
    const agentB = makeAgentConfig("agent-b");
    mockAgentRegistry.set("agent-a", agentA);
    mockAgentRegistry.set("agent-b", agentB);

    // agent-a responds with 20 chars, agent-b with 200 chars → agent-b wins on score
    const clientA = makeClient("short answer");        // 12 chars + 100 = 112
    const clientB = makeClient("a".repeat(200));       // 200 chars + 100 = 300

    const result = await runTournament(
      "t-001",
      ["agent-a", "agent-b"],
      ["test prompt"],
      (cfg) => cfg.id === "agent-a" ? clientA : clientB,
    );

    expect(result.tournamentId).toBe("t-001");
    expect(result.winner).toBe("agent-b");
    expect(result.rankings).toHaveLength(2);
    expect(result.rankings[0]!.agentId).toBe("agent-b");
    expect(result.rankings[1]!.agentId).toBe("agent-a");
    expect(result.rankings[0]!.avgScore).toBeGreaterThan(result.rankings[1]!.avgScore);
  });

  it("multiple prompts — avgScore is the mean of individual scores", async () => {
    const agent = makeAgentConfig("agent-x");
    mockAgentRegistry.set("agent-x", agent);

    // 3 prompts, responses: "aa" (2+100=102), "bbbb" (4+100=104), "cccccc" (6+100=106)
    // avg = (102 + 104 + 106) / 3 = 104
    const client: InferenceClient = {
      chat: vi.fn()
        .mockResolvedValueOnce({ content: "aa", toolCalls: [], usage: { prompt: 5, completion: 5, total: 10 }, finishReason: "stop" })
        .mockResolvedValueOnce({ content: "bbbb", toolCalls: [], usage: { prompt: 5, completion: 5, total: 10 }, finishReason: "stop" })
        .mockResolvedValueOnce({ content: "cccccc", toolCalls: [], usage: { prompt: 5, completion: 5, total: 10 }, finishReason: "stop" }),
      chatStream: vi.fn(),
    };

    const result = await runTournament("t-002", ["agent-x"], ["p1", "p2", "p3"], () => client);

    expect(result.rankings).toHaveLength(1);
    const ranking = result.rankings[0]!;
    expect(ranking.avgScore).toBe(Math.round((102 + 104 + 106) / 3));
    expect(ranking.responses).toHaveLength(3);
  });

  it("agent error scores 0 for that prompt", async () => {
    const agentA = makeAgentConfig("agent-ok");
    const agentB = makeAgentConfig("agent-fail");
    mockAgentRegistry.set("agent-ok", agentA);
    mockAgentRegistry.set("agent-fail", agentB);

    const goodClient = makeClient("good response");  // 13 + 100 = 113
    const failClient = makeFailingClient("timeout");  // score = 0

    const result = await runTournament(
      "t-003",
      ["agent-ok", "agent-fail"],
      ["prompt"],
      (cfg) => cfg.id === "agent-ok" ? goodClient : failClient,
    );

    const okRanking = result.rankings.find((r: AgentRanking) => r.agentId === "agent-ok")!;
    const failRanking = result.rankings.find((r: AgentRanking) => r.agentId === "agent-fail")!;

    expect(okRanking.avgScore).toBeGreaterThan(0);
    expect(failRanking.avgScore).toBe(0);
    expect(result.winner).toBe("agent-ok");

    // Error response string is set in responses array
    expect(failRanking.responses[0]!.response).toContain("ERROR");
    expect(failRanking.responses[0]!.score).toBe(0);
  });

  it("rankings are sorted by avgScore descending", async () => {
    const ids = ["agent-1", "agent-2", "agent-3"];
    const responses = ["x".repeat(50), "x".repeat(200), "x".repeat(100)];
    // Expected scores: 150, 300, 200 → sorted: agent-2, agent-3, agent-1

    for (const id of ids) {
      mockAgentRegistry.set(id, makeAgentConfig(id));
    }

    const result = await runTournament(
      "t-004",
      ids,
      ["prompt"],
      (cfg) => {
        const idx = ids.indexOf(cfg.id);
        return makeClient(responses[idx]!);
      },
    );

    expect(result.rankings[0]!.agentId).toBe("agent-2");
    expect(result.rankings[1]!.agentId).toBe("agent-3");
    expect(result.rankings[2]!.agentId).toBe("agent-1");
    // Verify strictly descending
    for (let i = 0; i < result.rankings.length - 1; i++) {
      expect(result.rankings[i]!.avgScore).toBeGreaterThanOrEqual(result.rankings[i + 1]!.avgScore);
    }
  });

  it("result is persisted to DB via pool.query UPDATE", async () => {
    const agent = makeAgentConfig("agent-persist");
    mockAgentRegistry.set("agent-persist", agent);

    await runTournament("t-005", ["agent-persist"], ["prompt"], () => makeClient("response"));

    const updateCall = mockPool.query.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("UPDATE agent_tournaments"),
    );
    expect(updateCall).toBeDefined();
    const params = updateCall![1] as unknown[];
    expect(params[2]).toBe("t-005"); // tournamentId = $3
    expect(params[1]).toBe("agent-persist"); // winner = $2
  });

  it("no agents → empty rankings, winner is empty string", async () => {
    const result = await runTournament("t-006", [], ["prompt"], () => makeClient("x"));

    expect(result.rankings).toHaveLength(0);
    expect(result.winner).toBe("");
  });

  it("completedAt is set and is a recent timestamp", async () => {
    const agent = makeAgentConfig("agent-ts");
    mockAgentRegistry.set("agent-ts", agent);

    const before = Date.now();
    const result = await runTournament("t-007", ["agent-ts"], ["p"], () => makeClient("hi"));
    const after = Date.now();

    expect(result.completedAt).toBeGreaterThanOrEqual(before);
    expect(result.completedAt).toBeLessThanOrEqual(after);
  });
});
