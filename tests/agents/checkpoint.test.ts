import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Tests for src/agents/checkpoint.ts ──────────────────────────────

const { mockPool } = vi.hoisted(() => {
  return {
    mockPool: {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      connect: vi.fn(),
      end: vi.fn(),
      on: vi.fn(),
      totalCount: 1,
      idleCount: 1,
      waitingCount: 0,
    },
  };
});

vi.mock("../../src/config/postgres.js", () => ({
  getPool: () => mockPool,
}));

vi.mock("../../src/utils/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  saveCheckpoint,
  listCheckpoints,
  getCheckpoint,
  deleteCheckpoint,
} from "../../src/agents/checkpoint.js";

// ── Helpers ───────────────────────────────────────────────────────────

function makeCheckpointRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "cp-1",
    sessionId: "sess-1",
    workspaceId: "ws-1",
    label: "before-refactor",
    messageCount: 3,
    tokenEstimate: 75,
    snapshot: [{ role: "user", content: "Hello" }],
    createdBy: "user-1",
    createdAt: new Date("2026-03-01"),
    ...overrides,
  };
}

function makeSampleMessages() {
  return [
    { role: "user", content: "Hello there" },
    { role: "assistant", content: "Hi! How can I help?" },
    { role: "user", content: "Tell me something." },
  ];
}

describe("saveCheckpoint", () => {
  beforeEach(() => vi.clearAllMocks());

  it("inserts a checkpoint row and returns the saved checkpoint", async () => {
    const row = makeCheckpointRow();
    mockPool.query.mockResolvedValue({ rows: [row] });

    const messages = makeSampleMessages();
    const result = await saveCheckpoint("sess-1", "ws-1", messages, "user-1", "before-refactor");

    expect(result).toBeDefined();
    expect(result.id).toBe("cp-1");
    expect(result.sessionId).toBe("sess-1");
    expect(result.label).toBe("before-refactor");
  });

  it("includes all necessary fields: messageCount and tokenEstimate", async () => {
    const row = makeCheckpointRow({ messageCount: 3, tokenEstimate: 75 });
    mockPool.query.mockResolvedValue({ rows: [row] });

    const messages = makeSampleMessages();
    await saveCheckpoint("sess-1", "ws-1", messages, "user-1");

    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO conversation_checkpoints");
    // params[4] = messageCount (messages.length)
    expect(params[4]).toBe(3);
    // params[5] = tokenEstimate (ceil(content.length / 4) summed)
    expect(params[5]).toBeGreaterThan(0);
  });

  it("snapshots the message array as JSON in the DB", async () => {
    const row = makeCheckpointRow();
    mockPool.query.mockResolvedValue({ rows: [row] });

    const messages = makeSampleMessages();
    await saveCheckpoint("sess-1", "ws-1", messages);

    const [, params] = mockPool.query.mock.calls[0];
    const snapshotJson = params[6];
    const parsed = JSON.parse(snapshotJson);
    expect(parsed).toHaveLength(3);
    expect(parsed[0].role).toBe("user");
  });
});

describe("listCheckpoints", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns checkpoints for the given session and workspace", async () => {
    const rows = [
      makeCheckpointRow({ id: "cp-1" }),
      makeCheckpointRow({ id: "cp-2", label: "after-refactor" }),
    ];
    mockPool.query.mockResolvedValue({ rows });

    const results = await listCheckpoints("sess-1", "ws-1");

    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("cp-1");
    expect(results[1].id).toBe("cp-2");
  });

  it("scopes query to session and workspace (workspace isolation)", async () => {
    mockPool.query.mockResolvedValue({ rows: [] });

    await listCheckpoints("sess-xyz", "ws-abc");

    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toContain("session_id");
    expect(sql).toContain("workspace_id");
    expect(params).toContain("sess-xyz");
    expect(params).toContain("ws-abc");
  });

  it("returns empty array when no checkpoints exist", async () => {
    mockPool.query.mockResolvedValue({ rows: [] });

    const results = await listCheckpoints("sess-none", "ws-1");

    expect(results).toEqual([]);
  });
});

describe("getCheckpoint", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a checkpoint by ID with workspace isolation", async () => {
    const row = makeCheckpointRow();
    mockPool.query.mockResolvedValue({ rows: [row] });

    const result = await getCheckpoint("cp-1", "ws-1");

    expect(result).not.toBeNull();
    expect(result?.id).toBe("cp-1");
    expect(result?.snapshot).toBeDefined();
  });

  it("returns null when checkpoint is not found", async () => {
    mockPool.query.mockResolvedValue({ rows: [] });

    const result = await getCheckpoint("cp-missing", "ws-1");

    expect(result).toBeNull();
  });
});

describe("deleteCheckpoint", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns true when checkpoint was deleted", async () => {
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 1 });

    const result = await deleteCheckpoint("cp-1", "ws-1");

    expect(result).toBe(true);
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toContain("DELETE FROM conversation_checkpoints");
    expect(params).toContain("cp-1");
    expect(params).toContain("ws-1");
  });

  it("returns false when checkpoint does not exist", async () => {
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await deleteCheckpoint("cp-gone", "ws-1");

    expect(result).toBe(false);
  });
});
