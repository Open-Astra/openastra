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
  findDuplicateSessions,
  mergeSessions,
} from "../../src/memory/session-dedup.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeSessionRow(id: string, firstMessage: string) {
  return { id, first_message: firstMessage };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────

describe("findDuplicateSessions", () => {
  it("detects duplicate sessions with identical first messages", async () => {
    const rows = [
      makeSessionRow("sess-1", "What is the weather today?"),
      makeSessionRow("sess-2", "What is the weather today?"),
      makeSessionRow("sess-3", "Tell me a joke"),
    ];
    mockPool.query.mockResolvedValue({ rows, rowCount: rows.length });

    const groups = await findDuplicateSessions("workspace-1");

    // sess-1 and sess-2 have identical messages → similarity = 1.0 ≥ 0.90 threshold
    expect(groups).toHaveLength(1);
    expect(groups[0]!.sessions).toContain("sess-1");
    expect(groups[0]!.sessions).toContain("sess-2");
    expect(groups[0]!.suggestedPrimary).toBe("sess-1");
  });

  it("does not flag unique messages as duplicates", async () => {
    const rows = [
      makeSessionRow("sess-a", "Hello world"),
      makeSessionRow("sess-b", "Completely different question about Python"),
      makeSessionRow("sess-c", "How do I bake a cake?"),
    ];
    mockPool.query.mockResolvedValue({ rows, rowCount: rows.length });

    const groups = await findDuplicateSessions("workspace-1");
    expect(groups).toHaveLength(0);
  });

  it("uses the default threshold of 0.90 and respects custom threshold", async () => {
    // "hello" vs "hellox" → similarity = 5/6 ≈ 0.833 → below 0.90, above 0.80
    const rows = [
      makeSessionRow("sess-1", "hello"),
      makeSessionRow("sess-2", "hellox"),
    ];
    mockPool.query.mockResolvedValue({ rows, rowCount: rows.length });

    // With default 0.90 threshold → NOT flagged
    const defaultGroups = await findDuplicateSessions("workspace-1");
    expect(defaultGroups).toHaveLength(0);

    // With 0.80 threshold → flagged
    mockPool.query.mockResolvedValue({ rows, rowCount: rows.length });
    const lowerGroups = await findDuplicateSessions("workspace-1", 0.80);
    expect(lowerGroups).toHaveLength(1);
  });

  it("returns empty array when no sessions have messages", async () => {
    // Rows with null first_message are filtered out
    const rows = [
      { id: "sess-1", first_message: null },
      { id: "sess-2", first_message: null },
    ];
    mockPool.query.mockResolvedValue({ rows, rowCount: rows.length });

    const groups = await findDuplicateSessions("workspace-1");
    expect(groups).toHaveLength(0);
  });

  it("cross-workspace isolation: query is scoped to workspace_id", async () => {
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

    await findDuplicateSessions("workspace-A");

    const [sql, params] = mockPool.query.mock.calls[0]! as [string, unknown[]];
    expect(sql).toContain("workspace_id");
    expect(params).toContain("workspace-A");
  });
});

describe("mergeSessions", () => {
  it("re-parents messages and marks duplicate as merged", async () => {
    // Sequence: BEGIN, SELECT ownership, UPDATE messages, UPDATE sessions, COMMIT
    mockPool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })              // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: "sess-dup" }], rowCount: 1 }) // ownership check
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })              // UPDATE messages
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })              // UPDATE sessions (merged_into)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });             // COMMIT

    await mergeSessions("sess-primary", ["sess-dup"], "workspace-1");

    const calls = mockPool.query.mock.calls;
    const sqlStatements = calls.map((c) => (c[0] as string).trim().toUpperCase());

    expect(sqlStatements[0]).toBe("BEGIN");
    // Messages re-parented
    const updateMsgCall = calls.find(
      (c) => (c[0] as string).includes("UPDATE messages"),
    );
    expect(updateMsgCall).toBeDefined();
    expect(updateMsgCall![1]).toContain("sess-primary");

    // Sessions marked as merged
    const mergeCall = calls.find(
      (c) => (c[0] as string).includes("merged_into"),
    );
    expect(mergeCall).toBeDefined();

    // COMMIT
    expect(sqlStatements[sqlStatements.length - 1]).toBe("COMMIT");
  });

  it("rolls back and rethrows on error", async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })              // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: "dup" }], rowCount: 1 }) // ownership check
      .mockRejectedValueOnce(new Error("DB failure"))                // UPDATE messages fails
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });             // ROLLBACK

    await expect(
      mergeSessions("sess-primary", ["dup"], "workspace-1"),
    ).rejects.toThrow("DB failure");

    const sqlStatements = mockPool.query.mock.calls.map((c) => (c[0] as string).trim().toUpperCase());
    expect(sqlStatements).toContain("ROLLBACK");
  });

  it("skips duplicate session if ownership check fails (wrong workspace)", async () => {
    // Ownership SELECT returns 0 rows → skip this duplicate, do nothing
    mockPool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // ownership check → not found
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT

    // Should not throw
    await mergeSessions("sess-primary", ["sess-other-workspace"], "workspace-A");

    const sqlStatements = mockPool.query.mock.calls.map((c) => (c[0] as string).trim().toUpperCase());
    expect(sqlStatements).toContain("COMMIT");
    // No UPDATE messages/sessions called since ownership failed
    const updateMsg = mockPool.query.mock.calls.find(
      (c) => (c[0] as string).includes("UPDATE messages"),
    );
    expect(updateMsg).toBeUndefined();
  });
});
