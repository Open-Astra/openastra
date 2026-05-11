import { vi, describe, it, expect, beforeEach } from "vitest";

const { mockGetMemberRole, mockCheckIpAllowlist } = vi.hoisted(() => ({
  mockGetMemberRole: vi.fn(),
  mockCheckIpAllowlist: vi.fn(),
}));

vi.mock("../../../src/workspaces/store.js", () => ({
  getMemberRole: mockGetMemberRole,
}));

vi.mock("../../../src/security/ip-allowlist.js", () => ({
  checkIpAllowlist: mockCheckIpAllowlist,
}));

import { workspaceResolver } from "../../../src/gateway/middleware/workspace.js";
import {
  createMockRequest,
  createMockResponse,
  createMockNext,
} from "../../helpers/mock-express.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckIpAllowlist.mockResolvedValue(true); // allow all IPs by default
});

describe("workspaceResolver middleware", () => {
  it("no X-Workspace-Id header → personal workspace (null, owner)", async () => {
    const req = createMockRequest({ uid: "user-1" }) as any;
    const res = createMockResponse();
    const next = createMockNext();

    await workspaceResolver()(req, res as any, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.workspace).toEqual({ workspaceId: null, role: "owner" });
    expect(mockGetMemberRole).not.toHaveBeenCalled();
  });

  it("valid X-Workspace-Id header with member role → workspace attached", async () => {
    mockGetMemberRole.mockResolvedValue("member");

    const req = createMockRequest({
      uid: "user-1",
      headers: { "x-workspace-id": "ws-abc" },
    }) as any;
    const res = createMockResponse();
    const next = createMockNext();

    await workspaceResolver()(req, res as any, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.workspace).toEqual({ workspaceId: "ws-abc", role: "member" });
  });

  it("workspace header with owner role → owner context attached", async () => {
    mockGetMemberRole.mockResolvedValue("owner");

    const req = createMockRequest({
      uid: "user-1",
      headers: { "x-workspace-id": "ws-xyz" },
    }) as any;
    const res = createMockResponse();
    const next = createMockNext();

    await workspaceResolver()(req, res as any, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.workspace).toEqual({ workspaceId: "ws-xyz", role: "owner" });
  });

  it("user is not a member of the workspace → 403", async () => {
    mockGetMemberRole.mockResolvedValue(null); // not a member

    const req = createMockRequest({
      uid: "stranger",
      headers: { "x-workspace-id": "ws-private" },
    }) as any;
    const res = createMockResponse();
    const next = createMockNext();

    await workspaceResolver()(req, res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Not a member of this workspace" }),
    );
  });

  it("IP not on allowlist → 403", async () => {
    mockGetMemberRole.mockResolvedValue("member");
    mockCheckIpAllowlist.mockResolvedValue(false); // IP blocked

    const req = createMockRequest({
      uid: "user-1",
      headers: { "x-workspace-id": "ws-restricted" },
      ip: "10.0.0.99",
    }) as any;
    const res = createMockResponse();
    const next = createMockNext();

    await workspaceResolver()(req, res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "IP address not permitted for this workspace" }),
    );
  });

  it("getMemberRole throws → 500", async () => {
    mockGetMemberRole.mockRejectedValue(new Error("DB failure"));

    const req = createMockRequest({
      uid: "user-1",
      headers: { "x-workspace-id": "ws-1" },
    }) as any;
    const res = createMockResponse();
    const next = createMockNext();

    await workspaceResolver()(req, res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Workspace resolution failed" }),
    );
  });

  it("workspace context has correct shape (WorkspaceContext typing)", async () => {
    mockGetMemberRole.mockResolvedValue("admin");

    const req = createMockRequest({
      uid: "user-1",
      headers: { "x-workspace-id": "ws-typed" },
    }) as any;
    const res = createMockResponse();
    const next = createMockNext();

    await workspaceResolver()(req, res as any, next);

    expect(req.workspace).toHaveProperty("workspaceId", "ws-typed");
    expect(req.workspace).toHaveProperty("role", "admin");
    expect(typeof req.workspace.workspaceId).toBe("string");
  });
});
