import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────
const { mockPool } = vi.hoisted(() => {
  const pool = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
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

vi.mock("../../src/utils/logger.js", () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  pinDailyMemory,
  unpinDailyMemory,
  getPinnedMemories,
} from "../../src/memory/pinning.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

// ── Tests ────────────────────────────────────────────────────────────

describe("pinDailyMemory", () => {
  it("executes UPDATE setting pinned=true and pinned_at for the entry", async () => {
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 1 });

    await pinDailyMemory("user-1", "2025-01-01", "ws-1");

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("pinned = true"),
      ["user-1", "2025-01-01", "ws-1"],
    );
  });

  it("throws when no matching daily_memory entry is found", async () => {
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

    await expect(
      pinDailyMemory("user-1", "2025-01-01", "ws-1"),
    ).rejects.toThrow("No daily_memory entry found for user=user-1 date=2025-01-01");
  });

  it("is idempotent — calling pin twice succeeds (UPDATE is safe to repeat)", async () => {
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 1 });

    await pinDailyMemory("user-1", "2025-01-01", "ws-1");
    await pinDailyMemory("user-1", "2025-01-01", "ws-1");

    expect(mockPool.query).toHaveBeenCalledTimes(2);
  });

  it("uses IS NOT DISTINCT FROM for workspaceId to handle NULL correctly", async () => {
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 1 });

    await pinDailyMemory("user-1", "2025-06-01", null as unknown as string);

    const [sql, params] = mockPool.query.mock.calls[0]! as [string, unknown[]];
    expect(sql).toContain("IS NOT DISTINCT FROM");
    expect(params[2]).toBeNull();
  });
});

describe("unpinDailyMemory", () => {
  it("executes UPDATE setting pinned=false and pinned_at=NULL", async () => {
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 1 });

    await unpinDailyMemory("user-1", "2025-01-01", "ws-1");

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("pinned = false"),
      ["user-1", "2025-01-01", "ws-1"],
    );
    const [sql] = mockPool.query.mock.calls[0]! as [string];
    expect(sql).toContain("pinned_at = NULL");
  });

  it("does not throw when no rows are updated (no-op unpin)", async () => {
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

    // unpinDailyMemory does NOT throw on 0 rowCount
    await expect(unpinDailyMemory("user-1", "2025-01-01", "ws-1")).resolves.toBeUndefined();
  });
});

describe("getPinnedMemories", () => {
  it("returns mapped PinnedMemory array for pinned=true entries", async () => {
    const now = new Date("2025-03-01T12:00:00Z");
    mockPool.query.mockResolvedValue({
      rows: [
        { user_id: "user-1", date: "2025-01-01", pinned_at: now },
        { user_id: "user-1", date: "2025-02-01", pinned_at: now },
      ],
      rowCount: 2,
    });

    const pinned = await getPinnedMemories("user-1", "ws-1");

    expect(pinned).toHaveLength(2);
    expect(pinned[0]).toMatchObject({
      id: "daily:user-1:2025-01-01",
      tier: "daily",
      userId: "user-1",
      date: "2025-01-01",
      pinnedAt: now,
    });
  });

  it("returns empty array when no pinned entries exist", async () => {
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

    const pinned = await getPinnedMemories("user-1", "ws-1");
    expect(pinned).toEqual([]);
  });

  it("queries with pinned=true filter scoped to userId and workspaceId", async () => {
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

    await getPinnedMemories("user-42", "ws-99");

    const [sql, params] = mockPool.query.mock.calls[0]! as [string, unknown[]];
    expect(sql).toContain("pinned = true");
    expect(params).toContain("user-42");
    expect(params).toContain("ws-99");
  });

  it("constructs id as 'daily:userId:date' composite", async () => {
    const now = new Date();
    mockPool.query.mockResolvedValue({
      rows: [{ user_id: "u1", date: "2025-05-10", pinned_at: now }],
      rowCount: 1,
    });

    const pinned = await getPinnedMemories("u1", "ws-1");
    expect(pinned[0]!.id).toBe("daily:u1:2025-05-10");
    expect(pinned[0]!.tier).toBe("daily");
  });
});
