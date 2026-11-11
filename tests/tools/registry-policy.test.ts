import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const { mockPool, mockRole, mockRequestApproval } = vi.hoisted(() => ({
  mockPool: { query: vi.fn().mockResolvedValue({ rows: [] }), connect: vi.fn(), on: vi.fn() },
  mockRole: vi.fn(),
  mockRequestApproval: vi.fn(),
}));

vi.mock("../../src/config/postgres.js", () => ({ getPool: () => mockPool }));
vi.mock("../../src/events/index.js", () => ({ getEventBus: () => ({ emit: vi.fn() }) }));
vi.mock("../../src/agents/approval-gate.js", () => ({
  requestApproval: (...a: unknown[]) => mockRequestApproval(...a),
}));
vi.mock("../../src/gateway/middleware/rbac.js", () => ({
  getWorkspaceRole: (...a: unknown[]) => mockRole(...a),
}));
vi.mock("../../src/skills/registry.js", () => ({ getSkillForTool: () => null }));
vi.mock("../../src/utils/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() }),
}));

import { z } from "zod";
import { registerTool, unregisterTool, executeTool } from "../../src/tools/registry.js";
import { setToolApprovalPolicy, resetToolApprovalPolicy } from "../../src/tools/approval-policy.js";
import type { ToolContext } from "../../src/tools/types.js";

const P = `rp${Date.now()}`;
const names: string[] = [];
const ctx: ToolContext = { uid: "u1", agentId: "a1", sessionId: "s1" };
const call = (name: string, args: unknown = {}) => ({ id: `c-${name}`, name, arguments: JSON.stringify(args) });

function reg(name: string, execute: (p: unknown, c: ToolContext) => Promise<unknown>) {
  names.push(name);
  registerTool({ name, description: name, parameters: z.object({}).passthrough(), execute });
}

beforeEach(() => {
  setToolApprovalPolicy({ requireApproval: [] });
  mockRequestApproval.mockResolvedValue(true);
});

afterEach(() => {
  for (const n of names.splice(0)) unregisterTool(n);
  resetToolApprovalPolicy();
  vi.clearAllMocks();
});

describe("executeTool — policy chain", () => {
  it("blocks a tool-running tool from executing something its caller cannot", async () => {
    const secret = vi.fn().mockResolvedValue({ leaked: true });
    reg(`${P}_dangerous`, secret);
    reg(`${P}_safe`, async () => ({ ok: true }));
    // "runner" mimics run_workflow / delegate_tool_call: it calls executeTool
    // with a fresh single-tool allow set.
    reg(`${P}_runner`, async (params, c) => {
      const target = (params as { target: string }).target;
      return executeTool(call(target), c, new Set([target]));
    });

    const agentAllow = new Set([`${P}_runner`, `${P}_safe`]);

    const blocked = await executeTool(call(`${P}_runner`, { target: `${P}_dangerous` }), ctx, agentAllow);
    expect(JSON.parse(blocked.content).error).toMatch(/not allowed/);
    expect(secret).not.toHaveBeenCalled();

    const allowed = await executeTool(call(`${P}_runner`, { target: `${P}_safe` }), ctx, agentAllow);
    expect(JSON.parse(JSON.parse(allowed.content).content)).toEqual({ ok: true });
  });

  it("deny wins even when the nested call lists the tool as allowed (hyphen/underscore insensitive)", async () => {
    const denied = vi.fn().mockResolvedValue({});
    reg(`${P}_shell_thing`, denied);
    reg(`${P}_runner2`, async (_p, c) =>
      executeTool(call(`${P}_shell_thing`), c, new Set([`${P}_shell_thing`])),
    );
    const res = await executeTool(
      call(`${P}_runner2`),
      { ...ctx, deniedTools: [`${P}-shell-thing`] },
      new Set([`${P}_runner2`, `${P}_shell_thing`]),
    );
    expect(JSON.parse(res.content).error).toMatch(/denied/);
    expect(denied).not.toHaveBeenCalled();
  });
});

describe("executeTool — RBAC fails closed", () => {
  it("blocks when the role lookup throws", async () => {
    const fn = vi.fn().mockResolvedValue({});
    reg(`${P}_rbac1`, fn);
    mockRole.mockRejectedValue(new Error("db down"));
    const res = await executeTool(call(`${P}_rbac1`), { ...ctx, workspaceId: "ws" }, new Set([`${P}_rbac1`]));
    expect(res.error).toMatch(/Access control check failed/);
    expect(fn).not.toHaveBeenCalled();
  });

  it("blocks when the user has no role in the workspace", async () => {
    const fn = vi.fn().mockResolvedValue({});
    reg(`${P}_rbac2`, fn);
    mockRole.mockResolvedValue(null);
    const res = await executeTool(call(`${P}_rbac2`), { ...ctx, workspaceId: "ws" }, new Set([`${P}_rbac2`]));
    expect(res.error).toMatch(/No role/);
    expect(fn).not.toHaveBeenCalled();
  });

  it("blocks a viewer from an unclassified (HIGH_RISK by default) tool", async () => {
    const fn = vi.fn().mockResolvedValue({});
    reg(`${P}_rbac3`, fn);
    mockRole.mockResolvedValue("viewer");
    const res = await executeTool(call(`${P}_rbac3`), { ...ctx, workspaceId: "ws" }, new Set([`${P}_rbac3`]));
    expect(res.error).toMatch(/cannot execute/);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("executeTool — approval gate is wired to config", () => {
  it("requires approval for tools named in the approval policy and blocks on rejection", async () => {
    const fn = vi.fn().mockResolvedValue({ ran: true });
    reg(`${P}_needs_ok`, fn);
    setToolApprovalPolicy({ requireApproval: [`${P}-needs-ok`], timeoutMs: 1234 });

    mockRequestApproval.mockResolvedValueOnce(false);
    const rejected = await executeTool(call(`${P}_needs_ok`), ctx, new Set([`${P}_needs_ok`]));
    expect(rejected.error).toBe("rejected");
    expect(fn).not.toHaveBeenCalled();
    expect(mockRequestApproval.mock.calls[0]![3]).toEqual({ timeoutMs: 1234 });

    mockRequestApproval.mockResolvedValueOnce(true);
    const ok = await executeTool(call(`${P}_needs_ok`), ctx, new Set([`${P}_needs_ok`]));
    expect(ok.error).toBeUndefined();
    expect(fn).toHaveBeenCalledOnce();
  });

  it("does not ask for approval for tools outside the policy", async () => {
    reg(`${P}_plain`, async () => ({}));
    await executeTool(call(`${P}_plain`), ctx, new Set([`${P}_plain`]));
    expect(mockRequestApproval).not.toHaveBeenCalled();
  });
});
