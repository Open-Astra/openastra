import { vi, describe, it, expect, beforeEach } from "vitest";
import type { AgentGoal } from "../../src/agents/goals.js";

// ── Tests for src/agents/goals.ts ───────────────────────────────────

const { mockPool } = vi.hoisted(() => {
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
  return { mockPool: pool };
});

vi.mock("../../src/config/postgres.js", () => ({
  getPool: () => mockPool,
}));

// ── Imports ──────────────────────────────────────────────────────────

import { loadActiveGoals, buildGoalContext, updateGoalProgress } from "../../src/agents/goals.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeGoalRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "goal-1",
    workspace_id: "ws-1",
    agent_id: "agent-1",
    uid: "user-1",
    title: "Improve response quality",
    description: "Achieve >90% positive feedback",
    status: "active",
    target_metrics: { satisfaction: 90 },
    progress: { satisfaction: 70 },
    created_at: new Date("2026-01-01"),
    updated_at: new Date("2026-01-02"),
    ...overrides,
  };
}

// ── loadActiveGoals tests ────────────────────────────────────────────

describe("loadActiveGoals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns mapped goals from DB rows", async () => {
    mockPool.query.mockResolvedValue({ rows: [makeGoalRow()] });

    const goals = await loadActiveGoals("agent-1", "user-1", "ws-1");

    expect(goals).toHaveLength(1);
    expect(goals[0].id).toBe("goal-1");
    expect(goals[0].workspaceId).toBe("ws-1");
    expect(goals[0].agentId).toBe("agent-1");
    expect(goals[0].title).toBe("Improve response quality");
    expect(goals[0].description).toBe("Achieve >90% positive feedback");
    expect(goals[0].status).toBe("active");
  });

  it("returns empty array when no active goals exist", async () => {
    mockPool.query.mockResolvedValue({ rows: [] });

    const goals = await loadActiveGoals("agent-1", "user-1", "ws-1");

    expect(goals).toEqual([]);
  });

  it("filters by workspaceId, agentId, and uid (verifies query parameters)", async () => {
    mockPool.query.mockResolvedValue({ rows: [] });

    await loadActiveGoals("agent-xyz", "user-abc", "ws-999");

    const [_sql, params] = mockPool.query.mock.calls[0];
    expect(params).toEqual(["ws-999", "agent-xyz", "user-abc"]);
  });

  it("correctly maps camelCase from snake_case DB columns", async () => {
    const row = makeGoalRow({
      target_metrics: { clicks: 100 },
      progress: { clicks: 50 },
      created_at: new Date("2026-02-01"),
      updated_at: new Date("2026-02-10"),
    });
    mockPool.query.mockResolvedValue({ rows: [row] });

    const goals = await loadActiveGoals("agent-1", "user-1", "ws-1");

    expect(goals[0].targetMetrics).toEqual({ clicks: 100 });
    expect(goals[0].progress).toEqual({ clicks: 50 });
    expect(goals[0].createdAt).toEqual(new Date("2026-02-01"));
    expect(goals[0].updatedAt).toEqual(new Date("2026-02-10"));
  });
});

// ── buildGoalContext tests ────────────────────────────────────────────

describe("buildGoalContext", () => {
  it("returns empty string for empty goals array", () => {
    const context = buildGoalContext([]);
    expect(context).toBe("");
  });

  it("formats a single goal as a bullet point", () => {
    const goal: AgentGoal = {
      id: "g-1",
      workspaceId: "ws-1",
      agentId: "agent-1",
      uid: "user-1",
      title: "Increase accuracy",
      description: "Reach 95% accuracy on benchmarks",
      status: "active",
      targetMetrics: {},
      progress: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const context = buildGoalContext([goal]);

    expect(context).toContain("Active goals:");
    expect(context).toContain("- Increase accuracy: Reach 95% accuracy on benchmarks");
  });

  it("formats multiple goals as separate bullet points", () => {
    const goals: AgentGoal[] = [
      {
        id: "g-1",
        workspaceId: "ws-1",
        agentId: "a-1",
        uid: "u-1",
        title: "Goal A",
        description: "Desc A",
        status: "active",
        targetMetrics: {},
        progress: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "g-2",
        workspaceId: "ws-1",
        agentId: "a-1",
        uid: "u-1",
        title: "Goal B",
        description: "Desc B",
        status: "active",
        targetMetrics: {},
        progress: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    const context = buildGoalContext(goals);

    expect(context).toContain("- Goal A: Desc A");
    expect(context).toContain("- Goal B: Desc B");
  });

  it("omits description colon when description is empty", () => {
    const goal: AgentGoal = {
      id: "g-1",
      workspaceId: "ws-1",
      agentId: "a-1",
      uid: "u-1",
      title: "No Description Goal",
      description: "",
      status: "active",
      targetMetrics: {},
      progress: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const context = buildGoalContext([goal]);

    expect(context).toContain("- No Description Goal");
    expect(context).not.toContain("No Description Goal:");
  });
});

// ── updateGoalProgress tests ─────────────────────────────────────────

describe("updateGoalProgress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPool.query.mockResolvedValue({ rows: [] });
  });

  it("issues an UPDATE query with the goal ID and delta", async () => {
    await updateGoalProgress("goal-123", { satisfaction: 85 });

    expect(mockPool.query).toHaveBeenCalledOnce();
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toContain("UPDATE agent_goals");
    expect(params[0]).toBe(JSON.stringify({ satisfaction: 85 }));
    expect(params[1]).toBe("goal-123");
  });
});
