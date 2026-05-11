import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockPool } = vi.hoisted(() => {
  const pool = {
    query: vi.fn(),
    connect: vi.fn(),
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

import {
  majorityVote,
  quorumApproval,
  runConsensus,
  initiateConsensus,
  submitVote,
  getConsensusRound,
  getConsensusRounds,
  resolveConsensus,
  type Vote,
} from "../../src/agents/consensus.js";

function makeVote(position: string, confidence = 1): Vote {
  return {
    agentRole: `role-${position}`,
    instanceId: `instance-${position}`,
    position,
    confidence,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("consensus engine", () => {
  it("resolves majority vote with a clear winner", () => {
    const result = majorityVote([makeVote("approve"), makeVote("approve"), makeVote("reject")]);

    expect(result.resolved).toBe(true);
    expect(result.resolution).toBe("approve");
    expect(result.metadata).toMatchObject({
      winnerCount: 2,
      totalVotes: 3,
    });
  });

  it("honors quorum thresholds using the participant count", () => {
    const result = quorumApproval(
      [makeVote("agree"), makeVote("agree"), makeVote("abstain")],
      0.67,
      3,
    );

    expect(result.resolved).toBe(true);
    expect(result.resolution).toBe("approved");
    expect(result.metadata).toMatchObject({
      normalizedApprovalRate: 0.67,
      totalParticipants: 3,
    });
  });

  it("runs the dispatcher for quorum consensus", async () => {
    const result = await runConsensus(
      [makeVote("agree"), makeVote("agree"), makeVote("disagree")],
      { strategy: "quorum", requiredQuorum: 0.67, participantCount: 3 },
    );

    expect(result.resolved).toBe(true);
    expect(result.resolution).toBe("approved");
  });
});

describe("consensus persistence compatibility", () => {
  it("creates and fetches consensus rounds", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const created = await initiateConsensus("ws-1", {
      topic: "Choose a direction",
      description: "Pick the best option",
      participants: ["a", "b", "c"],
      requiredMajority: 0.67,
    });

    expect(created.status).toBe("open");
    expect(created.participants).toEqual(["a", "b", "c"]);
    expect(mockPool.query).toHaveBeenCalledOnce();

    mockPool.query
      .mockResolvedValueOnce({
        rows: [{
          id: "round-1",
          workspaceId: "ws-1",
          topic: "Choose a direction",
          description: "Pick the best option",
          participants: ["a", "b", "c"],
          requiredMajority: 0.67,
          status: "open",
          result: null,
          resolvedAt: null,
          createdAt: new Date("2026-03-21T10:00:00Z"),
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          agentId: "agent-a",
          vote: "agree",
          reasoning: "Looks good",
          castAt: new Date("2026-03-21T10:01:00Z"),
        }],
      });

    const round = await getConsensusRound("round-1");
    expect(round?.votes).toHaveLength(1);
    expect(round?.votes[0]?.vote).toBe("agree");

    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: "round-2",
        workspaceId: "ws-1",
        topic: "Choose a direction",
        description: null,
        participants: ["a", "b", "c"],
        requiredMajority: 0.67,
        status: "open",
        result: null,
        resolvedAt: null,
        createdAt: new Date("2026-03-21T10:00:00Z"),
      }],
    });

    const rounds = await getConsensusRounds("ws-1");
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.id).toBe("round-2");
  });

  it("stores votes and resolves rounds through the legacy API", async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{
          agentId: "agent-a",
          vote: "agree",
          reasoning: "Aligned",
          castAt: new Date("2026-03-21T10:01:00Z"),
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: "round-9",
          workspaceId: "ws-1",
          topic: "Choose a direction",
          description: null,
          participants: ["a", "b", "c"],
          requiredMajority: 0.67,
          status: "open",
          result: null,
          resolvedAt: null,
          createdAt: new Date("2026-03-21T10:00:00Z"),
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          agentId: "agent-a",
          vote: "agree",
          reasoning: "Aligned",
          castAt: new Date("2026-03-21T10:01:00Z"),
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const vote = await submitVote("round-9", "agent-a", "agree", "Aligned");
    expect(vote.vote).toBe("agree");

    const resolved = await resolveConsensus("round-9");
    expect(resolved.status).toBe("open");
    expect(mockPool.query).toHaveBeenCalled();
  });
});
