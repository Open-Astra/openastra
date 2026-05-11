import { vi, describe, it, expect, beforeEach } from "vitest";

// vi.hoisted — pool mock must exist before vi.mock factories run
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

vi.mock("../../../src/config/postgres.js", () => ({
  getPool: () => mockPool,
}));

vi.mock("../../../src/utils/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { requireRole } from "../../../src/gateway/middleware/rbac.js";
import {
  createMockRequest,
  createMockResponse,
  createMockNext,
} from "../../helpers/mock-express.js";

// Helper to build a request with uid + workspace attached
function makeReq(uid: string, workspaceId: string | null) {
  const req = createMockRequest({
    uid,
    workspace: workspaceId ? { workspaceId, role: "member" } : undefined,
  });
  return req;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPool.query.mockResolvedValue({ rows: [] });
});

describe("requireRole middleware", () => {
  it("owner role passes an owner-required check", async () => {
    mockPool.query.mockResolvedValue({ rows: [{ role: "owner" }] });

    const req = makeReq("uid-1", "ws-1");
    const res = createMockResponse();
    const next = createMockNext();

    await requireRole("owner")(req as any, res as any, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("owner role passes editor-required check", async () => {
    mockPool.query.mockResolvedValue({ rows: [{ role: "owner" }] });

    const req = makeReq("uid-1", "ws-1");
    const res = createMockResponse();
    const next = createMockNext();

    await requireRole("editor")(req as any, res as any, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("admin (editor) role passes tool_runner-required check", async () => {
    mockPool.query.mockResolvedValue({ rows: [{ role: "admin" }] });

    const req = makeReq("uid-1", "ws-1");
    const res = createMockResponse();
    const next = createMockNext();

    await requireRole("tool_runner")(req as any, res as any, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("admin (editor) role fails owner-required check with 403", async () => {
    mockPool.query.mockResolvedValue({ rows: [{ role: "admin" }] });

    const req = makeReq("uid-1", "ws-1");
    const res = createMockResponse();
    const next = createMockNext();

    await requireRole("owner")(req as any, res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining("Insufficient") }),
    );
  });

  it("member (tool_runner) role passes viewer-required check", async () => {
    mockPool.query.mockResolvedValue({ rows: [{ role: "member" }] });

    const req = makeReq("uid-1", "ws-1");
    const res = createMockResponse();
    const next = createMockNext();

    await requireRole("viewer")(req as any, res as any, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("member (tool_runner) role fails editor-required check with 403", async () => {
    mockPool.query.mockResolvedValue({ rows: [{ role: "member" }] });

    const req = makeReq("uid-1", "ws-1");
    const res = createMockResponse();
    const next = createMockNext();

    await requireRole("editor")(req as any, res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("viewer role fails tool_runner-required check with 403", async () => {
    mockPool.query.mockResolvedValue({ rows: [{ role: "viewer" }] });

    const req = makeReq("uid-1", "ws-1");
    const res = createMockResponse();
    const next = createMockNext();

    await requireRole("tool_runner")(req as any, res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("no workspace context → 400", async () => {
    const req = createMockRequest({ uid: "uid-1" }); // no workspace field
    const res = createMockResponse();
    const next = createMockNext();

    await requireRole("viewer")(req as any, res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("no uid → 401", async () => {
    const req = createMockRequest({
      workspace: { workspaceId: "ws-1", role: "member" },
    }); // no uid
    const res = createMockResponse();
    const next = createMockNext();

    await requireRole("viewer")(req as any, res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("user with no role in workspace → 403 with descriptive error", async () => {
    mockPool.query.mockResolvedValue({ rows: [] }); // not a member

    const req = makeReq("uid-stranger", "ws-1");
    const res = createMockResponse();
    const next = createMockNext();

    await requireRole("viewer")(req as any, res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "No role assigned in this workspace" }),
    );
  });

  it("DB error → 500", async () => {
    mockPool.query.mockRejectedValue(new Error("pg down"));

    const req = makeReq("uid-1", "ws-1");
    const res = createMockResponse();
    const next = createMockNext();

    await requireRole("viewer")(req as any, res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
