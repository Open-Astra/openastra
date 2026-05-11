import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────
const { mockPool, mockBus } = vi.hoisted(() => {
  const pool = {
    query: vi.fn().mockResolvedValue({ rows: [{ id: "debate-session-1" }], rowCount: 1 }),
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
  };
  return { mockPool: pool, mockBus: bus };
});

vi.mock("../../src/config/postgres.js", () => ({
  getPool: () => mockPool,
}));

vi.mock("../../src/events/index.js", () => ({
  getEventBus: vi.fn().mockReturnValue(mockBus),
}));

vi.mock("../../src/agents/blackboard.js", () => ({
  writeToBlackboard: vi.fn().mockResolvedValue(undefined),
  resolveConflict: vi.fn().mockResolvedValue(undefined),
  escalateConflict: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/agents/audit.js", () => ({
  logAgentAction: vi.fn().mockResolvedValue("audit-id"),
}));

import {
  runDebate,
  runStructuredDebate,
  type DebateParticipant,
  type DebateConfig,
} from "../../src/agents/debate.js";
import { writeToBlackboard, resolveConflict, escalateConflict } from "../../src/agents/blackboard.js";
import type { AgentConfig } from "../../src/agents/types.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeAgentConfig(id: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id,
    displayName: `Agent ${id}`,
    tier: "free",
    model: {
      provider: "openai",
      modelId: "gpt-4o-mini",
      maxContextTokens: 8192,
      maxOutputTokens: 1024,
      temperature: 0.7,
    },
    systemPromptTemplate: `You are agent ${id}.`,
    tools: { allow: [], deny: [], maxToolCallsPerRound: 8 },
    skills: [],
    session: { dailyResetHour: 4, idleTimeoutMinutes: 120, maxContextMessages: 50 },
    spawn: { enabled: false, allowedTargets: [], maxDepth: 2 },
    fileAccess: { restricted: true, allowedPaths: [] },
    ...overrides,
  } as AgentConfig;
}

function makeParticipant(role: string, position: string): DebateParticipant {
  return {
    agentRole: role,
    instanceId: `instance-${role}`,
    originalPosition: position,
  };
}

/** Creates a mock inference client that returns given responses in order */
function makeMockClient(responses: Array<{ content: string }>) {
  const queue = [...responses];
  return {
    chat: vi.fn().mockImplementation(async () => {
      const next = queue.shift();
      if (!next) return { content: "{}", toolCalls: [] };
      return { content: next.content, toolCalls: [], usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 } };
    }),
    chatStream: vi.fn(),
  };
}

/** Mediator verdict JSON that signals consensus */
function makeConsensusVerdict(verdict = "Agreed resolution") {
  return JSON.stringify({
    winner: "analyst",
    confidence: 0.9,
    reasoning: "Both agents largely agree",
    verdict,
    consensusReached: true,
  });
}

/** Mediator verdict JSON that signals NO consensus */
function makeNoConsensusVerdict() {
  return JSON.stringify({
    winner: null,
    confidence: 0.4,
    reasoning: "Agents strongly disagree",
    verdict: "Unable to resolve",
    consensusReached: false,
  });
}

/** Position argument JSON */
function makePositionArg(position = "My position") {
  return JSON.stringify({ position, confidence: 0.8, evidence: ["fact-1"] });
}

/** Challenge JSON */
function makeChallengeArg(challenge = "I challenge your position") {
  return JSON.stringify({ challenges: challenge, confidence: 0.7, evidence: [] });
}

/** Rebuttal JSON */
function makeRebuttalArg(rebuttal = "My rebuttal") {
  return JSON.stringify({ rebuttal, confidence: 0.75, evidence: ["fact-2"] });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default pool behavior: INSERT returns id row
  mockPool.query.mockResolvedValue({ rows: [{ id: "debate-record-1" }], rowCount: 1 });
});

// ── runDebate tests ─────────────────────────────────────────────────

describe("runDebate", () => {
  it("two agents produce arguments and mediator resolves with consensus", async () => {
    const participants = [
      makeParticipant("analyst", "The market will rise"),
      makeParticipant("researcher", "The market will fall"),
    ];
    const baseConfig = makeAgentConfig("orchestrator");

    // Each debate round: 2 positions + 2 cross-exams + 2 rebuttals + 1 mediator = 7 calls per round
    // With maxRounds=1 and consensus on round 1
    const client = makeMockClient([
      { content: makePositionArg("Market will rise") },    // analyst position
      { content: makePositionArg("Market will fall") },    // researcher position
      { content: makeChallengeArg("You lack data") },      // analyst cross-exam
      { content: makeChallengeArg("Flawed model") },       // researcher cross-exam
      { content: makeRebuttalArg("Data is solid") },       // analyst rebuttal
      { content: makeRebuttalArg("Model is tested") },     // researcher rebuttal
      { content: makeConsensusVerdict("Market is uncertain — hedge position") }, // mediator
    ]);

    const result = await runDebate(
      "user-1",
      "swarm-1",
      "conflict-1",
      "market-analysis",
      participants,
      baseConfig,
      client,
      { maxRounds: 1, consensusThreshold: 0.7, allowUserEscalation: false, timeoutMs: 5000 },
    );

    expect(result.debateId).toBeDefined();
    expect(result.conflictId).toBe("conflict-1");
    expect(result.rounds).toHaveLength(1);
    expect(result.resolvedBy).toBe("mediator"); // consensus with winner
    expect(result.resolution).toBe("Market is uncertain — hedge position");
    // blackboard was updated
    expect(writeToBlackboard).toHaveBeenCalledOnce();
    expect(resolveConflict).toHaveBeenCalledOnce();
  });

  it("accumulates arguments across multiple rounds", async () => {
    const participants = [makeParticipant("agent-a", "Position A")];
    const baseConfig = makeAgentConfig("base");

    // Round 1: no consensus
    // Round 2: consensus
    const client = makeMockClient([
      // Round 1
      { content: makePositionArg("A1") },
      { content: makeChallengeArg("C1") },
      { content: makeRebuttalArg("R1") },
      { content: makeNoConsensusVerdict() },        // no consensus round 1
      // Round 2
      { content: makePositionArg("A2") },
      { content: makeChallengeArg("C2") },
      { content: makeRebuttalArg("R2") },
      { content: makeConsensusVerdict("Final answer") }, // consensus round 2
    ]);

    const result = await runDebate(
      "user-1", "swarm-1", "conflict-2", "topic",
      participants, baseConfig, client,
      { maxRounds: 3, consensusThreshold: 0.7, allowUserEscalation: false, timeoutMs: 5000 },
    );

    expect(result.rounds).toHaveLength(2);
    expect(result.totalRounds).toBe(2);
    expect(result.resolution).toBe("Final answer");
  });

  it("escalates to user when max rounds reached with no consensus and allowUserEscalation=true", async () => {
    const participants = [
      makeParticipant("agent-a", "Pos A"),
      makeParticipant("agent-b", "Pos B"),
    ];
    const baseConfig = makeAgentConfig("base");

    // All mediator verdicts return no consensus
    const client = makeMockClient([
      // Round 1: pos, cross, rebuttal x 2 each + mediator
      { content: makePositionArg() },
      { content: makePositionArg() },
      { content: makeChallengeArg() },
      { content: makeChallengeArg() },
      { content: makeRebuttalArg() },
      { content: makeRebuttalArg() },
      { content: makeNoConsensusVerdict() },
    ]);

    const result = await runDebate(
      "user-1", "swarm-1", "conflict-3", "topic",
      participants, baseConfig, client,
      { maxRounds: 1, consensusThreshold: 0.7, allowUserEscalation: true, timeoutMs: 5000 },
    );

    expect(result.resolvedBy).toBe("user");
    expect(result.resolution).toBeUndefined();
    expect(escalateConflict).toHaveBeenCalledOnce();
    expect(resolveConflict).not.toHaveBeenCalled();
  });

  it("forces mediator decision when max rounds reached and allowUserEscalation=false", async () => {
    const participants = [makeParticipant("agent-a", "Pos A")];
    const baseConfig = makeAgentConfig("base");

    const client = makeMockClient([
      { content: makePositionArg() },
      { content: makeChallengeArg() },
      { content: makeRebuttalArg() },
      { content: makeNoConsensusVerdict() }, // no consensus but forced
    ]);

    const result = await runDebate(
      "user-1", "swarm-1", "conflict-4", "topic",
      participants, baseConfig, client,
      { maxRounds: 1, consensusThreshold: 0.7, allowUserEscalation: false, timeoutMs: 5000 },
    );

    expect(result.resolvedBy).toBe("mediator");
    expect(result.resolution).toBe("Unable to resolve"); // from makeNoConsensusVerdict
    expect(resolveConflict).toHaveBeenCalledOnce();
    expect(escalateConflict).not.toHaveBeenCalled();
  });

  it("handles malformed mediator JSON gracefully (falls back to defaults)", async () => {
    const participants = [makeParticipant("agent-a", "Pos A")];
    const baseConfig = makeAgentConfig("base");

    const client = makeMockClient([
      { content: makePositionArg() },
      { content: makeChallengeArg() },
      { content: makeRebuttalArg() },
      { content: "not valid json at all!!" }, // mediator returns garbage
    ]);

    // Should not throw — fallback assessment has consensusReached=false, confidence=0.3
    const result = await runDebate(
      "user-1", "swarm-1", "conflict-5", "topic",
      participants, baseConfig, client,
      { maxRounds: 1, consensusThreshold: 0.7, allowUserEscalation: false, timeoutMs: 5000 },
    );

    // No consensus → forced mediator resolution
    expect(result.resolvedBy).toBe("mediator");
    expect(result.resolution).toContain("Unable to resolve");
  });
});

// ── runStructuredDebate tests ────────────────────────────────────────

describe("runStructuredDebate", () => {
  it("executes three-turn debate: agent A, agent B, judge", async () => {
    const agentA = makeAgentConfig("agent-a");
    const agentB = makeAgentConfig("agent-b");
    const judge = makeAgentConfig("judge");

    const clientA = makeMockClient([{ content: "I believe X is better." }]);
    const clientB = makeMockClient([{ content: "I disagree, Y is better." }]);
    const clientJudge = makeMockClient([
      { content: "Both have merit. Winner rationale: X wins on efficiency." },
    ]);

    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: "session-abc" }], rowCount: 1 }) // INSERT debate_sessions
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });                       // UPDATE debate_sessions

    const result = await runStructuredDebate(
      "X vs Y",
      agentA, agentB, judge,
      clientA, clientB, clientJudge,
      "workspace-1",
    );

    expect(result.sessionId).toBe("session-abc");
    expect(result.topic).toBe("X vs Y");
    expect(result.rounds).toHaveLength(3);
    expect(result.rounds[0]!.speaker).toBe("agent_a");
    expect(result.rounds[0]!.content).toBe("I believe X is better.");
    expect(result.rounds[1]!.speaker).toBe("agent_b");
    expect(result.rounds[2]!.speaker).toBe("judge");
    expect(result.synthesis).toContain("Winner rationale");
    expect(result.winnerRationale).toBe("X wins on efficiency.");
  });

  it("both agents produce distinct arguments", async () => {
    const agentA = makeAgentConfig("agent-a");
    const agentB = makeAgentConfig("agent-b");
    const judge = makeAgentConfig("judge");

    const posA = "Approach A is faster.";
    const posB = "Approach B is more accurate.";

    const clientA = makeMockClient([{ content: posA }]);
    const clientB = makeMockClient([{ content: posB }]);
    const clientJudge = makeMockClient([{ content: "Both approaches have merit. Winner rationale: Tie." }]);

    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: "session-2" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await runStructuredDebate(
      "A vs B", agentA, agentB, judge,
      clientA, clientB, clientJudge,
      "workspace-1",
    );

    const argA = result.rounds.find((r) => r.speaker === "agent_a")!;
    const argB = result.rounds.find((r) => r.speaker === "agent_b")!;
    expect(argA.content).toBe(posA);
    expect(argB.content).toBe(posB);
    expect(argA.content).not.toBe(argB.content);
  });

  it("emits debate.completed event on the event bus", async () => {
    const agentA = makeAgentConfig("agent-a");
    const agentB = makeAgentConfig("agent-b");
    const judge = makeAgentConfig("judge");

    const clientA = makeMockClient([{ content: "Position A" }]);
    const clientB = makeMockClient([{ content: "Position B" }]);
    const clientJudge = makeMockClient([{ content: "Judge synthesis. Winner rationale: Both" }]);

    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: "session-evt" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await runStructuredDebate(
      "event topic", agentA, agentB, judge,
      clientA, clientB, clientJudge,
      "workspace-bus",
    );

    expect(mockBus.emit).toHaveBeenCalledWith(
      "debate.completed",
      expect.objectContaining({
        sessionId: "session-evt",
        workspaceId: "workspace-bus",
        topic: "event topic",
        agentAId: "agent-a",
        agentBId: "agent-b",
        judgeAgentId: "judge",
      }),
    );
  });

  it("uses fallback winnerRationale when judge response has no 'Winner rationale:' section", async () => {
    const agentA = makeAgentConfig("agent-a");
    const agentB = makeAgentConfig("agent-b");
    const judge = makeAgentConfig("judge");

    const judgeContent = "Both positions are equally valid. No clear winner.";
    const clientA = makeMockClient([{ content: "Pos A" }]);
    const clientB = makeMockClient([{ content: "Pos B" }]);
    const clientJudge = makeMockClient([{ content: judgeContent }]);

    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: "session-fallback" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await runStructuredDebate(
      "test", agentA, agentB, judge,
      clientA, clientB, clientJudge,
      "workspace-1",
    );

    // No "Winner rationale:" in judge response → winnerRationale = full content
    expect(result.winnerRationale).toBe(judgeContent);
  });
});
