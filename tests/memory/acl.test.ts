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
  setMemoryACL,
  getMemoryACL,
  deleteMemoryACL,
  canAccessMemory,
  listWorkspaceACLs,
  type MemoryACL,
} from "../../src/memory/acl.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeACLRow(overrides: Partial<MemoryACL> = {}): MemoryACL {
  return {
    id: "acl-1",
    workspaceId: "ws-1",
    memoryId: "mem-1",
    memoryTable: "daily_memory",
    visibility: "workspace",
    allowedUids: [],
    createdBy: "user-1",
    createdAt: new Date("2025-01-01"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

// ── Tests ────────────────────────────────────────────────────────────

describe("setMemoryACL", () => {
  it("upserts an ACL record and returns the resulting MemoryACL", async () => {
    const row = makeACLRow();
    mockPool.query.mockResolvedValue({ rows: [row], rowCount: 1 });

    const acl = await setMemoryACL("ws-1", "mem-1", "daily_memory", "workspace", [], "user-1");

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO memory_acl"),
      expect.arrayContaining(["ws-1", "mem-1", "daily_memory", "workspace"]),
    );
    expect(acl.workspaceId).toBe("ws-1");
    expect(acl.memoryId).toBe("mem-1");
    expect(acl.visibility).toBe("workspace");
  });

  it("uses ON CONFLICT ... DO UPDATE so existing ACL is overwritten", async () => {
    const row = makeACLRow({ visibility: "private" });
    mockPool.query.mockResolvedValue({ rows: [row], rowCount: 1 });

    await setMemoryACL("ws-1", "mem-1", "daily_memory", "private");

    const [sql] = mockPool.query.mock.calls[0]! as [string];
    expect(sql).toContain("ON CONFLICT");
    expect(sql).toContain("DO UPDATE");
  });

  it("stores allowedUids in the INSERT parameters", async () => {
    const row = makeACLRow({ allowedUids: ["uid-a", "uid-b"], visibility: "cross-workspace" });
    mockPool.query.mockResolvedValue({ rows: [row], rowCount: 1 });

    await setMemoryACL("ws-1", "mem-1", "daily_memory", "cross-workspace", ["uid-a", "uid-b"]);

    const [, params] = mockPool.query.mock.calls[0]! as [string, unknown[]];
    expect(params).toContain("cross-workspace");
    const uidParam = params.find((p) => Array.isArray(p) && (p as string[]).includes("uid-a"));
    expect(uidParam).toBeDefined();
  });
});

describe("getMemoryACL", () => {
  it("returns the ACL when found", async () => {
    const row = makeACLRow();
    mockPool.query.mockResolvedValue({ rows: [row], rowCount: 1 });

    const acl = await getMemoryACL("ws-1", "mem-1", "daily_memory");
    expect(acl).not.toBeNull();
    expect(acl!.visibility).toBe("workspace");
  });

  it("returns null when no ACL exists", async () => {
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

    const acl = await getMemoryACL("ws-1", "mem-missing", "daily_memory");
    expect(acl).toBeNull();
  });
});

describe("deleteMemoryACL", () => {
  it("returns true when a row is deleted", async () => {
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 1 });

    const deleted = await deleteMemoryACL("ws-1", "mem-1", "daily_memory");
    expect(deleted).toBe(true);
  });

  it("returns false when no row matched", async () => {
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

    const deleted = await deleteMemoryACL("ws-1", "nonexistent", "daily_memory");
    expect(deleted).toBe(false);
  });
});

describe("canAccessMemory", () => {
  it("same workspace: allows access when no ACL exists (private default)", async () => {
    // getMemoryACL returns null → default private, same workspace → allow
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

    const allowed = await canAccessMemory("ws-1", "uid-1", "ws-1", "mem-1", "daily_memory");
    expect(allowed).toBe(true);
  });

  it("different workspace: blocks access when no ACL exists (private default)", async () => {
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

    const allowed = await canAccessMemory("ws-other", "uid-1", "ws-1", "mem-1", "daily_memory");
    expect(allowed).toBe(false);
  });

  it("visibility=workspace: allows same workspace, blocks different workspace", async () => {
    const row = makeACLRow({ visibility: "workspace", allowedUids: [] });
    mockPool.query.mockResolvedValue({ rows: [row], rowCount: 1 });

    const sameWs = await canAccessMemory("ws-1", "uid-any", "ws-1", "mem-1", "daily_memory");
    expect(sameWs).toBe(true);

    mockPool.query.mockResolvedValue({ rows: [row], rowCount: 1 });
    const diffWs = await canAccessMemory("ws-2", "uid-any", "ws-1", "mem-1", "daily_memory");
    expect(diffWs).toBe(false);
  });

  it("visibility=cross-workspace: allows uid in allowedUids list", async () => {
    const row = makeACLRow({ visibility: "cross-workspace", allowedUids: ["uid-external"] });
    mockPool.query.mockResolvedValue({ rows: [row], rowCount: 1 });

    const allowed = await canAccessMemory("ws-2", "uid-external", "ws-1", "mem-1", "daily_memory");
    expect(allowed).toBe(true);
  });

  it("visibility=cross-workspace: blocks uid NOT in allowedUids list", async () => {
    const row = makeACLRow({ visibility: "cross-workspace", allowedUids: ["uid-external"] });
    mockPool.query.mockResolvedValue({ rows: [row], rowCount: 1 });

    const blocked = await canAccessMemory("ws-2", "uid-stranger", "ws-1", "mem-1", "daily_memory");
    expect(blocked).toBe(false);
  });

  it("visibility=private with allowedUids: same workspace uid must be in list", async () => {
    const row = makeACLRow({
      visibility: "private",
      workspaceId: "ws-1",
      allowedUids: ["uid-approved"],
    });
    mockPool.query.mockResolvedValue({ rows: [row], rowCount: 1 });

    const allowed = await canAccessMemory("ws-1", "uid-approved", "ws-1", "mem-1", "daily_memory");
    expect(allowed).toBe(true);

    mockPool.query.mockResolvedValue({ rows: [row], rowCount: 1 });
    const blocked = await canAccessMemory("ws-1", "uid-not-approved", "ws-1", "mem-1", "daily_memory");
    expect(blocked).toBe(false);
  });
});

describe("listWorkspaceACLs", () => {
  it("returns ACL entries scoped to the workspace", async () => {
    const rows = [makeACLRow(), makeACLRow({ id: "acl-2", memoryId: "mem-2" })];
    mockPool.query.mockResolvedValue({ rows, rowCount: rows.length });

    const acls = await listWorkspaceACLs("ws-1");
    expect(acls).toHaveLength(2);
    expect(acls[0]!.workspaceId).toBe("ws-1");
  });

  it("passes workspaceId and limit to the query", async () => {
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

    await listWorkspaceACLs("ws-abc", 10);

    const [sql, params] = mockPool.query.mock.calls[0]! as [string, unknown[]];
    expect(params).toContain("ws-abc");
    expect(params).toContain(10);
    expect(sql).toContain("ORDER BY");
  });
});
