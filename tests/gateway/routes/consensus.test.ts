import { describe, expect, it, vi, beforeEach } from "vitest";
import { createMockResponse } from "../../helpers/mock-express.js";

const { mockPool } = vi.hoisted(() => {
  const pool = {
    query: vi.fn(),
    connect: vi.fn(),
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

import { createConsensusRouter } from "../../../src/gateway/routes/consensus.js";

function callRoute(
  router: ReturnType<typeof createConsensusRouter>,
  method: "get" | "post",
  path: string,
  overrides: Record<string, unknown> = {},
) {
  const layer = (router as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route?.methods?.[method],
  );

  if (!layer) {
    throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  }

  // The route handler is the last entry; /:id routes are preceded by the
  // requireOwned() workspace-ownership guard (covered in its own test below).
  const handler = layer.route.stack.at(-1).handle;
  const req = {
    method: method.toUpperCase(),
    path,
    params: {},
    query: {},
    body: {},
    headers: {},
    workspace: { workspaceId: "workspace-1" },
    get: vi.fn(),
    ...overrides,
  };

  const res = createMockResponse();
  return Promise.resolve(handler(req, res, vi.fn())).then(() => ({ req, res }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("consensus router", () => {
  it("creates and resolves consensus rounds through the public API", async () => {
    const roundRow = {
      id: "round-1",
      workspaceId: "workspace-1",
      topic: "Ship it",
      description: "Pick the final answer",
      participants: ["agent-a", "agent-b", "agent-c"],
      requiredMajority: 0.67,
      status: "open",
      result: null,
      resolvedAt: null,
      createdAt: new Date("2026-03-21T10:00:00Z"),
    };

    mockPool.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("INSERT INTO consensus_rounds")) {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO consensus_votes")) {
        return {
          rows: [{
            agentId: params[2],
            vote: params[3],
            reasoning: params[4],
            castAt: new Date("2026-03-21T10:01:00Z"),
          }],
        };
      }
      if (sql.includes("FROM consensus_rounds") && sql.includes("WHERE id = $1")) {
        return { rows: [roundRow] };
      }
      if (sql.includes("FROM consensus_votes") && sql.includes("WHERE round_id = $1")) {
        return {
          rows: [
            { agentId: "agent-a", vote: "agree", reasoning: "yes", castAt: new Date("2026-03-21T10:01:00Z") },
            { agentId: "agent-b", vote: "agree", reasoning: "yes", castAt: new Date("2026-03-21T10:02:00Z") },
            { agentId: "agent-c", vote: "disagree", reasoning: "no", castAt: new Date("2026-03-21T10:03:00Z") },
          ],
        };
      }
      if (sql.includes("UPDATE consensus_rounds")) {
        return { rows: [] };
      }
      if (sql.includes("FROM consensus_rounds") && sql.includes("WHERE workspace_id = $1")) {
        return { rows: [roundRow] };
      }
      return { rows: [] };
    });

    const router = createConsensusRouter();

    const createResult = await callRoute(router, "post", "/consensus/rounds", {
      body: {
        topic: "Ship it",
        description: "Pick the final answer",
        participants: ["agent-a", "agent-b", "agent-c"],
        requiredMajority: 0.67,
      },
    });
    expect(createResult.res.status).toHaveBeenCalledWith(201);
    expect((createResult.res.json as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      topic: "Ship it",
      status: "open",
    });

    const voteResult = await callRoute(router, "post", "/consensus/rounds/:id/votes", {
      params: { id: "round-1" },
      body: {
        agentId: "agent-a",
        vote: "agree",
        reasoning: "Looks good",
      },
    });
    expect(voteResult.res.status).toHaveBeenCalledWith(201);
    expect((voteResult.res.json as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      vote: "agree",
      agentId: "agent-a",
    });

    const resolveResult = await callRoute(router, "post", "/consensus/rounds/:id/resolve", {
      params: { id: "round-1" },
    });
    expect((resolveResult.res.json as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      status: "resolved",
      result: "approved",
    });
  });

  it("rejects round creation without a workspace", async () => {
    const router = createConsensusRouter();
    const result = await callRoute(router, "post", "/consensus/rounds", {
      workspace: { workspaceId: null },
      body: {
        topic: "Ship it",
        participants: ["agent-a"],
      },
    });

    expect(result.res.status).toHaveBeenCalledWith(400);
    expect((result.res.json as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      error: "Workspace required",
    });
  });
});

describe("consensus router — tenant isolation", () => {
  it("guards every /:id route with a workspace-ownership check", async () => {
    const router = createConsensusRouter();
    const idRoutes = (router as any).stack.filter((l: any) => l.route?.path?.includes(":id"));
    expect(idRoutes.length).toBeGreaterThan(0);

    for (const layer of idRoutes) {
      // guard + handler
      expect(layer.route.stack.length).toBeGreaterThanOrEqual(2);
      const guard = layer.route.stack[0].handle;

      // A round owned by another workspace → 404, handler never reached
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      const res = createMockResponse();
      const next = vi.fn();
      await guard(
        { params: { id: "11111111-1111-1111-1111-111111111111" }, workspace: { workspaceId: "workspace-1" } },
        res,
        next,
      );
      expect(res.status).toHaveBeenCalledWith(404);
      expect(next).not.toHaveBeenCalled();
      const [sql, params] = mockPool.query.mock.calls.at(-1)!;
      expect(sql).toContain("workspace_id = $2");
      expect(params).toEqual(["11111111-1111-1111-1111-111111111111", "workspace-1"]);

      // Owned → passes through
      mockPool.query.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });
      const next2 = vi.fn();
      await guard(
        { params: { id: "11111111-1111-1111-1111-111111111111" }, workspace: { workspaceId: "workspace-1" } },
        createMockResponse(),
        next2,
      );
      expect(next2).toHaveBeenCalled();

      // No workspace → 400
      const res3 = createMockResponse();
      await guard({ params: { id: "x" }, workspace: { workspaceId: null } }, res3, vi.fn());
      expect(res3.status).toHaveBeenCalledWith(400);
    }
  });
});
