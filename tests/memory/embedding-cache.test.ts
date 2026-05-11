import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

// ── Hoisted shared mocks ────────────────────────────────────────────
const { mockPool } = vi.hoisted(() => {
  const pool = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    connect: vi.fn().mockResolvedValue({ query: vi.fn(), release: vi.fn() }),
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
  getCachedEmbedding,
  setCachedEmbedding,
  hashText,
} from "../../src/memory/embedding-cache.js";

// ── Helpers ─────────────────────────────────────────────────────────

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function makeEmbedding(seed = 1): number[] {
  return Array.from({ length: 4 }, (_, i) => seed + i * 0.1);
}

// ── Tests ────────────────────────────────────────────────────────────

describe("embedding-cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: Postgres returns no cached embedding
    mockPool.query.mockResolvedValue({ rows: [] });
  });

  describe("hashText", () => {
    it("returns a 64-character hex SHA-256 digest", () => {
      const hash = hashText("hello world");
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is deterministic for the same input", () => {
      expect(hashText("same input")).toBe(hashText("same input"));
    });

    it("produces different hashes for different inputs", () => {
      expect(hashText("text A")).not.toBe(hashText("text B"));
    });

    it("matches a manually computed SHA-256 hash", () => {
      const text = "test embedding input";
      expect(hashText(text)).toBe(sha256(text));
    });
  });

  describe("getCachedEmbedding", () => {
    it("returns null on a cold miss (not in LRU, not in Postgres)", async () => {
      mockPool.query.mockResolvedValue({ rows: [] });
      const result = await getCachedEmbedding("uncached text " + Math.random());
      expect(result).toBeNull();
    });

    it("returns the embedding from Postgres on an LRU miss", async () => {
      const embedding = makeEmbedding(5);
      const pgFormat = "[" + embedding.join(",") + "]";
      mockPool.query.mockResolvedValue({ rows: [{ embedding: pgFormat }] });

      const uniqueText = "postgres-only-" + Math.random();
      const result = await getCachedEmbedding(uniqueText);
      expect(result).toEqual(embedding);
    });

    it("returns the embedding from LRU cache without hitting Postgres on a subsequent call", async () => {
      const embedding = makeEmbedding(7);
      const text = "lru-hit-text-" + Math.random();

      // Seed the LRU via setCachedEmbedding
      await setCachedEmbedding(text, embedding);
      vi.clearAllMocks(); // Clear any Postgres calls from setCachedEmbedding

      // Now getCachedEmbedding should hit LRU and not call Postgres
      const result = await getCachedEmbedding(text);
      expect(result).toEqual(embedding);
      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it("returns null gracefully when Postgres throws an error", async () => {
      mockPool.query.mockRejectedValue(new Error("db connection lost"));
      const result = await getCachedEmbedding("db-error-text-" + Math.random());
      expect(result).toBeNull();
    });
  });

  describe("setCachedEmbedding", () => {
    it("stores the embedding in LRU so subsequent getCachedEmbedding returns it", async () => {
      const embedding = makeEmbedding(3);
      const text = "set-then-get-" + Math.random();

      await setCachedEmbedding(text, embedding);
      vi.clearAllMocks();

      const result = await getCachedEmbedding(text);
      expect(result).toEqual(embedding);
      // LRU hit — should NOT have queried Postgres
      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it("fires a Postgres INSERT as fire-and-forget (resolves without awaiting DB)", async () => {
      // Make the Postgres query resolve slowly — setCachedEmbedding should return quickly
      let queryResolved = false;
      mockPool.query.mockImplementation(
        () => new Promise<{ rows: unknown[] }>((resolve) => {
          setTimeout(() => { queryResolved = true; resolve({ rows: [] }); }, 200);
        }),
      );

      const embedding = makeEmbedding(2);
      await setCachedEmbedding("fire-and-forget-" + Math.random(), embedding);
      // setCachedEmbedding must return before the 200ms Postgres delay completes
      expect(queryResolved).toBe(false);
    });

    it("handles concurrent requests for the same key (idempotent LRU writes)", async () => {
      const text = "concurrent-" + Math.random();
      const embedding = makeEmbedding(9);

      // Simulate two concurrent sets
      await Promise.all([
        setCachedEmbedding(text, embedding),
        setCachedEmbedding(text, embedding),
      ]);

      vi.clearAllMocks();
      const result = await getCachedEmbedding(text);
      expect(result).toEqual(embedding);
    });
  });
});
