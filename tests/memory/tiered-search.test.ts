import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted shared mocks ────────────────────────────────────────────
const { mockPool, mockSearchPgvector, mockSearchTypesense, mockGenerateEmbedding, mockSearchDocuments } =
  vi.hoisted(() => {
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
      mockSearchPgvector: vi.fn(),
      mockSearchTypesense: vi.fn(),
      mockGenerateEmbedding: vi.fn(),
      mockSearchDocuments: vi.fn(),
    };
  });

vi.mock("../../src/config/postgres.js", () => ({
  getPool: () => mockPool,
}));

vi.mock("../../src/memory/pg-search.js", () => ({
  searchMemoryPgvector: mockSearchPgvector,
}));

vi.mock("../../src/memory/search.js", () => ({
  searchMemory: mockSearchTypesense,
}));

vi.mock("../../src/memory/rag.js", () => ({
  searchDocuments: mockSearchDocuments,
}));

vi.mock("../../src/memory/embeddings.js", () => ({
  generateEmbedding: mockGenerateEmbedding,
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

import {
  searchAllTiers,
  reciprocalRankFusion,
  applyAccessBoost,
} from "../../src/memory/tiered-search.js";
import type { MemorySearchResult } from "../../src/memory/types.js";

// ── Helpers ─────────────────────────────────────────────────────────

function makeResult(content: string, score: number, source: MemorySearchResult["source"] = "daily"): MemorySearchResult {
  return { content, source, score };
}

const UID = "test-uid-tiered";

// ── Tests ────────────────────────────────────────────────────────────

describe("reciprocalRankFusion", () => {
  it("returns an empty array when all result sets are empty", () => {
    const fused = reciprocalRankFusion([], []);
    expect(fused).toEqual([]);
  });

  it("returns results from a single backend unchanged in rank order", () => {
    const results = [
      makeResult("alpha", 0.9),
      makeResult("beta", 0.7),
      makeResult("gamma", 0.5),
    ];
    const fused = reciprocalRankFusion(results, []);
    expect(fused).toHaveLength(3);
    // First result gets rank 0 → highest RRF score
    expect(fused[0]!.content).toBe("alpha");
    expect(fused[1]!.content).toBe("beta");
    expect(fused[2]!.content).toBe("gamma");
  });

  it("boosts a document that appears in both backends", () => {
    // "shared" appears at rank 0 in both lists
    const pgResults = [makeResult("shared", 0.9), makeResult("only-pg", 0.5)];
    const tsResults = [makeResult("shared", 0.8), makeResult("only-ts", 0.4)];

    const fused = reciprocalRankFusion(pgResults, tsResults);
    // "shared" appears in both → higher combined RRF score
    expect(fused[0]!.content).toBe("shared");
  });

  it("deduplicates entries by content prefix (first 200 chars)", () => {
    const dup = makeResult("duplicate content", 0.9);
    const fused = reciprocalRankFusion([dup], [dup]);
    // Despite appearing in both lists, same content key → deduplicated
    const dupItems = fused.filter((r) => r.content === "duplicate content");
    expect(dupItems).toHaveLength(1);
  });

  it("assigns RRF scores based on 1/(60+rank+1) formula", () => {
    const results = [makeResult("top", 0.9), makeResult("second", 0.5)];
    const fused = reciprocalRankFusion(results);
    // Rank 0: 1/(60+0+1) = 1/61 ≈ 0.01639
    // Rank 1: 1/(60+1+1) = 1/62 ≈ 0.01613
    expect(fused[0]!.score).toBeCloseTo(1 / 61, 4);
    expect(fused[1]!.score).toBeCloseTo(1 / 62, 4);
  });
});

describe("applyAccessBoost", () => {
  it("returns results unchanged when metadata is missing", () => {
    const results = [{ content: "test", tier: "daily" as const, source: "daily", score: 0.5 }];
    const boosted = applyAccessBoost(results);
    expect(boosted[0]!.score).toBe(0.5);
  });

  it("boosts score for results with accessCount > 0 and a recent lastAccessedAt", () => {
    const now = new Date().toISOString();
    const results = [{
      content: "accessed",
      tier: "daily" as const,
      source: "daily",
      score: 0.5,
      metadata: { accessCount: 10, lastAccessedAt: now },
    }];
    const boosted = applyAccessBoost(results);
    expect(boosted[0]!.score).toBeGreaterThan(0.5);
  });
});

describe("searchAllTiers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: both backends return empty results
    mockSearchPgvector.mockResolvedValue([]);
    mockSearchTypesense.mockResolvedValue([]);
    mockSearchDocuments.mockResolvedValue([]);
    // Procedural fast-path: pool returns no matching procedures
    mockPool.query.mockResolvedValue({ rows: [] });
    // graph: embedding returns valid vector
    mockGenerateEmbedding.mockResolvedValue(new Array(768).fill(0.1));
  });

  it("returns fused results from both pgvector and Typesense backends", async () => {
    mockSearchPgvector.mockResolvedValue([makeResult("pg-result", 0.9)]);
    mockSearchTypesense.mockResolvedValue([makeResult("ts-result", 0.8)]);

    const results = await searchAllTiers(UID, "test query", 10);

    // Both results should appear (content tiers mapped to ephemeral/daily/longterm)
    const contents = results.map((r) => r.content);
    expect(contents).toContain("pg-result");
    expect(contents).toContain("ts-result");
  });

  it("returns empty array when all backends return empty results", async () => {
    mockSearchPgvector.mockResolvedValue([]);
    mockSearchTypesense.mockResolvedValue([]);

    const results = await searchAllTiers(UID, "empty query", 10);
    // Graph results may appear from mock pool; filter only non-graph
    const nonGraph = results.filter((r) => r.tier !== "graph");
    expect(nonGraph).toHaveLength(0);
  });

  it("handles per-backend timeout by returning partial results with degraded flag", async () => {
    // Simulate a slow pgvector backend by making it never resolve within timeout
    mockSearchPgvector.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve([makeResult("late-pg", 0.5)]), 5000)),
    );
    mockSearchTypesense.mockResolvedValue([makeResult("fast-ts", 0.8)]);

    // Override the timeout to something tiny for this test
    const origEnv = process.env.MEMORY_BACKEND_TIMEOUT_MS;
    process.env.MEMORY_BACKEND_TIMEOUT_MS = "50";

    const results = await searchAllTiers(UID, "timeout query", 10);
    const tsResult = results.find((r) => r.content === "fast-ts");
    // Fast backend result should still appear
    expect(tsResult).toBeDefined();

    process.env.MEMORY_BACKEND_TIMEOUT_MS = origEnv;
  });

  it("respects profile.maxContextChunks to limit result count", async () => {
    mockSearchPgvector.mockResolvedValue(
      Array.from({ length: 20 }, (_, i) => makeResult(`pg-${i}`, 1 - i * 0.04)),
    );
    mockSearchTypesense.mockResolvedValue([]);

    const results = await searchAllTiers(UID, "query", 20, {
      maxContextChunks: 3,
      minRelevanceScore: 0,
      tiersEnabled: { session: true, daily: true, profile: true, graph: false, procedural: false, rag: false },
    });

    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("filters out results below minRelevanceScore", async () => {
    mockSearchPgvector.mockResolvedValue([
      makeResult("high-score", 0.9),
      makeResult("low-score", 0.001),
    ]);
    mockSearchTypesense.mockResolvedValue([]);

    // RRF scores are small fractions; use a very small minRelevanceScore
    // to verify filtering happens
    const results = await searchAllTiers(UID, "filter query", 10, {
      maxContextChunks: 10,
      minRelevanceScore: 0.02, // above typical RRF score of ~0.016
      tiersEnabled: { session: true, daily: true, profile: true, graph: false, procedural: false, rag: false },
    });

    // After RRF fusion, all scores are < 0.02, so all should be filtered
    expect(results).toHaveLength(0);
  });

  it("skips disabled tiers based on profile.tiersEnabled", async () => {
    mockSearchPgvector.mockResolvedValue([makeResult("pg-result", 0.9)]);
    mockSearchTypesense.mockResolvedValue([makeResult("ts-result", 0.8)]);

    const results = await searchAllTiers(UID, "query", 10, {
      maxContextChunks: 10,
      minRelevanceScore: 0,
      tiersEnabled: {
        session: false,
        daily: false,
        profile: false,
        graph: false,
        procedural: false,
        rag: false,
      },
    });

    // All tiers disabled: memory backends, graph, and procedural should all be skipped
    expect(results).toHaveLength(0);
  });

  it("sorts final results by score in descending order", async () => {
    mockSearchPgvector.mockResolvedValue([
      makeResult("low", 0.3),
      makeResult("high", 0.95),
      makeResult("mid", 0.6),
    ]);
    mockSearchTypesense.mockResolvedValue([]);

    const results = await searchAllTiers(UID, "sorting query", 10, {
      maxContextChunks: 10,
      minRelevanceScore: 0,
      tiersEnabled: { session: true, daily: true, profile: true, graph: false, procedural: false, rag: false },
    });

    // After RRF, higher-ranked originals get higher RRF scores
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    }
  });

  it("includes graph results with tier='graph' when graph tier is enabled", async () => {
    mockSearchPgvector.mockResolvedValue([]);
    mockSearchTypesense.mockResolvedValue([]);
    mockGenerateEmbedding.mockResolvedValue(new Array(768).fill(0.1));

    // Mock graph entity query
    mockPool.query.mockImplementation(async (sql: string) => {
      if (sql.includes("graph_entities")) {
        return {
          rows: [{
            entity_id: "ent-1",
            entity_name: "Alice",
            entity_type: "person",
            description: "A key person",
            vector_score: 0.85,
            related_id: null,
            related_name: null,
            related_type: null,
            edge_type: null,
            hop_distance: null,
          }],
        };
      }
      return { rows: [] };
    });

    const results = await searchAllTiers(UID, "graph query", 10, {
      maxContextChunks: 10,
      minRelevanceScore: 0,
      tiersEnabled: { session: false, daily: false, profile: false, graph: true, procedural: false, rag: false },
    });

    const graphResult = results.find((r) => r.tier === "graph");
    expect(graphResult).toBeDefined();
    expect(graphResult!.content).toContain("Alice");
  });

  it("includes procedural result when a workflow is matched with confidence > 0.5", async () => {
    mockSearchPgvector.mockResolvedValue([]);
    mockSearchTypesense.mockResolvedValue([]);

    mockPool.query.mockImplementation(async (sql: string) => {
      if (sql.includes("procedural_memory")) {
        return {
          rows: [{
            id: "proc-1",
            title: "Deploy Pipeline",
            trigger_pattern: "deploy",
            steps: [{ action: "run", command: "npm run build" }],
            execution_count: 10,
            success_count: 9,
          }],
        };
      }
      return { rows: [] };
    });

    const results = await searchAllTiers(UID, "deploy", 10, {
      maxContextChunks: 10,
      minRelevanceScore: 0,
      tiersEnabled: { session: false, daily: false, profile: false, graph: false, procedural: true, rag: false },
    });

    const procResult = results.find((r) => r.tier === "procedural");
    expect(procResult).toBeDefined();
    expect(procResult!.content).toContain("Deploy Pipeline");
    expect(procResult!.score).toBeGreaterThan(0.5);
  });
});
