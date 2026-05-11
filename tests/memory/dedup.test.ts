import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted shared mocks ────────────────────────────────────────────
const { mockPool, mockFindOrCreateEntity } = vi.hoisted(() => {
  const pool = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    connect: vi.fn().mockResolvedValue({ query: vi.fn(), release: vi.fn() }),
    end: vi.fn(),
    on: vi.fn(),
    totalCount: 1,
    idleCount: 1,
    waitingCount: 0,
  };
  return {
    mockPool: pool,
    mockFindOrCreateEntity: vi.fn().mockResolvedValue({ id: "entity-1" }),
  };
});

vi.mock("../../src/config/postgres.js", () => ({
  getPool: () => mockPool,
}));

vi.mock("../../src/memory/graph.js", () => ({
  findOrCreateEntity: mockFindOrCreateEntity,
}));

vi.mock("../../src/utils/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    dim: vi.fn(),
    active: vi.fn(),
    warn: vi.fn(),
  }),
}));

import { runMemoryDeduplication } from "../../src/memory/dedup.js";

// ── Helpers ─────────────────────────────────────────────────────────

const UID = "test-uid-dedup";

function makeRecentRow(id: string) {
  return { id };
}

function makeDupRow(idA: string, idB: string, similarity = 0.95) {
  return {
    id_a: idA,
    id_b: idB,
    content_a: `Content for ${idA}`,
    content_b: `Content for ${idB}`,
    category: "note",
    similarity,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("runMemoryDeduplication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindOrCreateEntity.mockResolvedValue({ id: "entity-1" });
  });

  it("returns zero counts when there are no recent memories with embeddings", async () => {
    // Step 1: recent rows query → empty
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const result = await runMemoryDeduplication(UID);

    expect(result).toEqual({ processed: 0, duplicates: 0, consolidated: 0 });
    // The duplicate-pair query should NOT be called
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  it("returns the correct processed count from the recent rows query", async () => {
    // Step 1: 3 recent rows
    mockPool.query
      .mockResolvedValueOnce({ rows: [makeRecentRow("r1"), makeRecentRow("r2"), makeRecentRow("r3")] })
      // Step 2: no duplicates found
      .mockResolvedValueOnce({ rows: [] });

    const result = await runMemoryDeduplication(UID);

    expect(result.processed).toBe(3);
    expect(result.duplicates).toBe(0);
    expect(result.consolidated).toBe(0);
  });

  it("consolidates duplicate pairs that exceed the 0.92 cosine threshold", async () => {
    const dupRow = makeDupRow("a1", "b1", 0.95);

    mockPool.query
      .mockResolvedValueOnce({ rows: [makeRecentRow("a1"), makeRecentRow("b1")] }) // recent rows
      .mockResolvedValueOnce({ rows: [dupRow] }); // duplicate pairs

    const result = await runMemoryDeduplication(UID);

    expect(result.duplicates).toBe(1);
    expect(result.consolidated).toBe(1);
    expect(mockFindOrCreateEntity).toHaveBeenCalledOnce();
    expect(mockFindOrCreateEntity).toHaveBeenCalledWith(
      UID,
      "note",
      expect.stringContaining("[Consolidated]"),
      "deduplicated",
    );
  });

  it("preserves separate documents when similarity is below 0.92 (SQL handles this — zero dup rows returned)", async () => {
    // The SQL query only returns pairs with similarity >= 0.92.
    // Here we simulate the DB returning NO pairs (both documents kept).
    mockPool.query
      .mockResolvedValueOnce({ rows: [makeRecentRow("x1"), makeRecentRow("x2")] })
      .mockResolvedValueOnce({ rows: [] }); // below threshold — not returned by SQL

    const result = await runMemoryDeduplication(UID);

    expect(result.duplicates).toBe(0);
    expect(result.consolidated).toBe(0);
    expect(mockFindOrCreateEntity).not.toHaveBeenCalled();
  });

  it("avoids processing the same document ID twice across multiple pairs", async () => {
    // Two pairs sharing id_a = "shared" — only the first should be consolidated
    const pairs = [
      makeDupRow("shared", "b1", 0.96),
      makeDupRow("shared", "b2", 0.94),
    ];

    mockPool.query
      .mockResolvedValueOnce({ rows: [makeRecentRow("shared"), makeRecentRow("b1"), makeRecentRow("b2")] })
      .mockResolvedValueOnce({ rows: pairs });

    const result = await runMemoryDeduplication(UID);

    // Only first pair should be consolidated — "shared" is in seenIds after that
    expect(result.duplicates).toBe(2);
    expect(result.consolidated).toBe(1);
    expect(mockFindOrCreateEntity).toHaveBeenCalledTimes(1);
  });

  it("handles findOrCreateEntity failures gracefully (best-effort)", async () => {
    const dupRow = makeDupRow("c1", "c2", 0.97);
    mockPool.query
      .mockResolvedValueOnce({ rows: [makeRecentRow("c1"), makeRecentRow("c2")] })
      .mockResolvedValueOnce({ rows: [dupRow] });

    // Make the graph entity creation throw
    mockFindOrCreateEntity.mockRejectedValueOnce(new Error("graph write failed"));

    // Should not throw — errors are caught silently
    const result = await runMemoryDeduplication(UID);

    expect(result.duplicates).toBe(1);
    // consolidated stays 0 because the consolidation failed
    expect(result.consolidated).toBe(0);
  });

  it("consolidates multiple independent pairs in a single run", async () => {
    const pairs = [
      makeDupRow("p1", "p2", 0.95),
      makeDupRow("p3", "p4", 0.93),
      makeDupRow("p5", "p6", 0.92),
    ];

    mockPool.query
      .mockResolvedValueOnce({
        rows: ["p1","p2","p3","p4","p5","p6"].map(makeRecentRow),
      })
      .mockResolvedValueOnce({ rows: pairs });

    const result = await runMemoryDeduplication(UID);

    expect(result.duplicates).toBe(3);
    expect(result.consolidated).toBe(3);
    expect(mockFindOrCreateEntity).toHaveBeenCalledTimes(3);
  });
});
