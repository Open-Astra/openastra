import { describe, it, expect } from "vitest";

// decay.ts is pure logic — no external dependencies to mock
import {
  computeImportanceScore,
  rankMemoriesByImportance,
  pruneByImportance,
  type DecayConfig,
} from "../../src/memory/decay.js";

// ── Helpers ──────────────────────────────────────────────────────────

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

function makeMemory(overrides: {
  createdAt?: Date;
  lastAccessedAt?: Date;
  accessCount?: number;
  reinforcementScore?: number;
}) {
  return {
    createdAt: overrides.createdAt ?? daysAgo(0),
    lastAccessedAt: overrides.lastAccessedAt,
    accessCount: overrides.accessCount ?? 0,
    reinforcementScore: overrides.reinforcementScore ?? 0,
  };
}

function makeRow(overrides: {
  created_at?: string;
  access_count?: number;
  reinforcement_score?: number;
  last_accessed_at?: string;
  id?: string;
}) {
  return {
    id: overrides.id ?? "mem-1",
    created_at: overrides.created_at ?? new Date().toISOString(),
    access_count: overrides.access_count,
    reinforcement_score: overrides.reinforcement_score,
    last_accessed_at: overrides.last_accessed_at,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("computeImportanceScore", () => {
  it("returns a high score for a very fresh memory (age=0)", () => {
    const mem = makeMemory({ createdAt: daysAgo(0) });
    const score = computeImportanceScore(mem);
    // exp(0) = 1.0 plus any bonuses
    expect(score).toBeGreaterThan(0.99);
  });

  it("decays score over time — older memories score lower", () => {
    const fresh = makeMemory({ createdAt: daysAgo(1) });
    const old = makeMemory({ createdAt: daysAgo(60) });

    const freshScore = computeImportanceScore(fresh);
    const oldScore = computeImportanceScore(old);

    expect(freshScore).toBeGreaterThan(oldScore);
  });

  it("access count adds a bonus proportional to accessBonus config", () => {
    const baseline = makeMemory({ createdAt: daysAgo(10), accessCount: 0 });
    const accessed = makeMemory({ createdAt: daysAgo(10), accessCount: 5 });

    const baseScore = computeImportanceScore(baseline);
    const accessedScore = computeImportanceScore(accessed);

    // accessBonus=0.05 * 5 = +0.25
    expect(accessedScore - baseScore).toBeCloseTo(0.25, 5);
  });

  it("reinforcement score adds weighted bonus", () => {
    const baseline = makeMemory({ createdAt: daysAgo(10), reinforcementScore: 0 });
    const reinforced = makeMemory({ createdAt: daysAgo(10), reinforcementScore: 2 });

    const baseScore = computeImportanceScore(baseline);
    const reinforcedScore = computeImportanceScore(reinforced);

    // reinforcementWeight=0.2 * 2 = +0.4
    expect(reinforcedScore - baseScore).toBeCloseTo(0.4, 5);
  });

  it("custom config changes decay rate — shorter halfLife decays faster", () => {
    const slowConfig: DecayConfig = { halfLifeDays: 90, accessBonus: 0, reinforcementWeight: 0 };
    const fastConfig: DecayConfig = { halfLifeDays: 3, accessBonus: 0, reinforcementWeight: 0 };

    const mem = makeMemory({ createdAt: daysAgo(10) });

    const slowScore = computeImportanceScore(mem, slowConfig);
    const fastScore = computeImportanceScore(mem, fastConfig);

    expect(slowScore).toBeGreaterThan(fastScore);
  });

  it("fresh memory (age ~0) near 1.0 and decayed memory below threshold with short halfLife", () => {
    const aggressiveConfig: DecayConfig = {
      halfLifeDays: 1,
      accessBonus: 0,
      reinforcementWeight: 0,
    };

    const fresh = makeMemory({ createdAt: daysAgo(0) });
    const stale = makeMemory({ createdAt: daysAgo(30) });

    const freshScore = computeImportanceScore(fresh, aggressiveConfig);
    const staleScore = computeImportanceScore(stale, aggressiveConfig);

    expect(freshScore).toBeGreaterThan(0.9);
    // exp(-ln2 * 30/1) = exp(-20.7) ≈ effectively 0
    expect(staleScore).toBeLessThan(0.01);
  });
});

describe("rankMemoriesByImportance", () => {
  it("sorts memories descending by importance (fresher first)", () => {
    const memories = [
      makeRow({ id: "old", created_at: daysAgo(60).toISOString() }),
      makeRow({ id: "fresh", created_at: daysAgo(1).toISOString() }),
      makeRow({ id: "medium", created_at: daysAgo(15).toISOString() }),
    ];

    const ranked = rankMemoriesByImportance(memories);
    expect(ranked[0]!.id).toBe("fresh");
    expect(ranked[1]!.id).toBe("medium");
    expect(ranked[2]!.id).toBe("old");
  });

  it("access_count and reinforcement_score break ties between same-age entries", () => {
    const base = daysAgo(10).toISOString();
    const memories = [
      makeRow({ id: "plain", created_at: base, access_count: 0, reinforcement_score: 0 }),
      makeRow({ id: "accessed", created_at: base, access_count: 10, reinforcement_score: 0 }),
    ];

    const ranked = rankMemoriesByImportance(memories);
    expect(ranked[0]!.id).toBe("accessed");
    expect(ranked[1]!.id).toBe("plain");
  });

  it("returns empty array unchanged", () => {
    expect(rankMemoriesByImportance([])).toEqual([]);
  });
});

describe("pruneByImportance", () => {
  it("returns only the top N most important memories", () => {
    const memories = [
      makeRow({ id: "old", created_at: daysAgo(60).toISOString() }),
      makeRow({ id: "fresh", created_at: daysAgo(0).toISOString() }),
      makeRow({ id: "medium", created_at: daysAgo(10).toISOString() }),
    ];

    const pruned = pruneByImportance(memories, 2);
    expect(pruned).toHaveLength(2);
    // Top 2 should be fresh and medium
    const ids = pruned.map((m) => m.id);
    expect(ids).toContain("fresh");
    expect(ids).toContain("medium");
    expect(ids).not.toContain("old");
  });

  it("returns all entries when topN >= length", () => {
    const memories = [
      makeRow({ id: "a", created_at: daysAgo(1).toISOString() }),
      makeRow({ id: "b", created_at: daysAgo(5).toISOString() }),
    ];
    const pruned = pruneByImportance(memories, 10);
    expect(pruned).toHaveLength(2);
  });
});
