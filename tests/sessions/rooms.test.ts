import { vi, describe, it, expect, beforeEach } from "vitest";

const { mockPool } = vi.hoisted(() => {
  const pool = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    connect: vi.fn().mockResolvedValue({ query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() }),
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
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  createRoom,
  joinRoom,
  leaveRoom,
  getRoomMembers,
  getRoom,
} from "../../src/sessions/rooms.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockPool.query.mockResolvedValue({ rows: [] });
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("createRoom", () => {
  it("inserts a room row and calls joinRoom for creator, returning the room id", async () => {
    const roomId = await createRoom("sess-1", "user-abc", "ws-1");

    expect(typeof roomId).toBe("string");
    expect(roomId.length).toBeGreaterThan(0);

    // First call: INSERT INTO session_rooms
    const insertCall = mockPool.query.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("INSERT INTO session_rooms"),
    );
    expect(insertCall).toBeDefined();

    // joinRoom also calls INSERT INTO session_room_members
    const joinCall = mockPool.query.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("session_room_members"),
    );
    expect(joinCall).toBeDefined();
  });

  it("passes workspaceId, sessionId, and creatorUid to the INSERT", async () => {
    await createRoom("sess-42", "creator-uid", "workspace-xyz");

    const insertCall = mockPool.query.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("INSERT INTO session_rooms"),
    );
    const params = insertCall![1] as unknown[];
    // params: [id, workspaceId, sessionId, createdBy]
    expect(params[1]).toBe("workspace-xyz");
    expect(params[2]).toBe("sess-42");
    expect(params[3]).toBe("creator-uid");
  });
});

describe("joinRoom", () => {
  it("upserts member row with ON CONFLICT handling", async () => {
    await joinRoom("room-1", "uid-bob");

    const call = mockPool.query.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("session_room_members"),
    );
    expect(call).toBeDefined();
    const sql = call![0] as string;
    expect(sql).toContain("ON CONFLICT");

    const params = call![1] as unknown[];
    expect(params[0]).toBe("room-1");
    expect(params[1]).toBe("uid-bob");
  });
});

describe("leaveRoom", () => {
  it("sets left_at timestamp for the member", async () => {
    await leaveRoom("room-2", "uid-carol");

    const call = mockPool.query.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("left_at"),
    );
    expect(call).toBeDefined();
    const sql = call![0] as string;
    expect(sql).toContain("UPDATE session_room_members");

    const params = call![1] as unknown[];
    expect(params[0]).toBe("room-2");
    expect(params[1]).toBe("uid-carol");
  });
});

describe("getRoomMembers", () => {
  it("returns uid list for active members (left_at IS NULL)", async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ uid: "uid-alice" }, { uid: "uid-bob" }],
    });

    const members = await getRoomMembers("room-3");

    expect(members).toEqual(["uid-alice", "uid-bob"]);

    const call = mockPool.query.mock.calls[0] as unknown[];
    const sql = call[0] as string;
    expect(sql).toContain("left_at IS NULL");
    const params = call[1] as unknown[];
    expect(params[0]).toBe("room-3");
  });

  it("returns empty array when no active members found", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const members = await getRoomMembers("room-empty");
    expect(members).toEqual([]);
  });
});

describe("getRoom", () => {
  it("returns room details mapped from DB row", async () => {
    const createdAt = new Date("2024-01-01T00:00:00Z");
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: "room-abc",
          session_id: "sess-xyz",
          created_by: "uid-owner",
          created_at: createdAt,
        },
      ],
    });

    const room = await getRoom("room-abc", "ws-1");

    expect(room).not.toBeNull();
    expect(room!.id).toBe("room-abc");
    expect(room!.sessionId).toBe("sess-xyz");
    expect(room!.createdBy).toBe("uid-owner");
    expect(room!.createdAt).toEqual(createdAt);
  });

  it("returns null when no room found for the given id and workspaceId", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const room = await getRoom("nonexistent", "ws-1");
    expect(room).toBeNull();
  });

  it("queries with both roomId and workspaceId as parameters", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await getRoom("room-99", "ws-my-workspace");

    const call = mockPool.query.mock.calls[0] as unknown[];
    const params = call[1] as unknown[];
    expect(params).toContain("room-99");
    expect(params).toContain("ws-my-workspace");
  });
});
