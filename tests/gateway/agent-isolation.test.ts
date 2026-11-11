import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/utils/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), dim: vi.fn(), active: vi.fn(), warn: vi.fn() }),
}));

const query = vi.fn();
vi.mock("../../src/config/postgres.js", () => ({
  getPool: () => ({ query: (...args: unknown[]) => query(...args) }),
}));

const registry = new Map<string, unknown>();
vi.mock("../../src/config/agents.js", () => ({
  getAgentConfig: (id: string) => {
    const c = registry.get(id);
    if (!c) throw new Error(`Unknown agent: ${id}`);
    return c;
  },
  registerAgentConfig: (id: string, c: unknown) => registry.set(id, c),
  unregisterAgentConfig: (id: string) => registry.delete(id),
}));

const getMemberRole = vi.fn();
vi.mock("../../src/workspaces/store.js", () => ({
  getMemberRole: (...args: unknown[]) => getMemberRole(...args),
}));

const checkTokenBudget = vi.fn();
vi.mock("../../src/billing/budget-check.js", () => ({
  checkTokenBudget: (...args: unknown[]) => checkTokenBudget(...args),
}));

import {
  resolveAgentForWorkspace,
  getAgentConfigById,
  deleteAgentConfig,
} from "../../src/agents/config-store.js";
import { authorizeAgentRun } from "../../src/gateway/agent-access.js";

// Regression tests for the critical audit finding: a request with no
// X-Workspace-Id got { workspaceId: null, role: "owner" }, and a null
// workspace dropped the tenant filter — any tenant's agent could be read
// and run from the shared in-memory registry.

const tenantAgent = {
  id: "acme-private",
  model: { provider: "openai", modelId: "gpt-4o" },
  systemPromptTemplate: "ACME SECRET PROMPT",
};
const globalAgent = {
  id: "assistant",
  model: { provider: "openai", modelId: "gpt-4o-mini" },
  systemPromptTemplate: "public",
};

/** agent_configs rows keyed by agent id → owning workspace (null = global row). */
let owners: Record<string, string | null>;

beforeEach(() => {
  registry.clear();
  registry.set(tenantAgent.id, tenantAgent);
  registry.set(globalAgent.id, globalAgent);
  owners = { "acme-private": "ws-acme" };

  getMemberRole.mockReset();
  checkTokenBudget.mockReset();
  checkTokenBudget.mockResolvedValue({ allowed: true });

  query.mockReset();
  query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith("SELECT workspace_id FROM agent_configs")) {
      const id = params[0] as string;
      return { rows: id in owners ? [{ workspace_id: owners[id] }] : [] };
    }
    if (sql.includes("workspace_agent_grants")) return { rows: [] };
    if (sql.includes("FROM workspaces")) return { rows: [{ allowed_providers: null, allowed_models: null }] };
    return { rows: [], rowCount: 0 };
  });
});

describe("resolveAgentForWorkspace — personal scope", () => {
  it("denies another tenant's agent when no workspace is given", async () => {
    expect(await resolveAgentForWorkspace("acme-private", tenantAgent as never, undefined)).toBeNull();
    expect(await resolveAgentForWorkspace("acme-private", tenantAgent as never, null)).toBeNull();
  });

  it("still serves global (astra.yml) agents without a workspace", async () => {
    const r = await resolveAgentForWorkspace("assistant", globalAgent as never, undefined);
    expect(r?.source).toBe("global");
  });

  it("denies a different workspace without a grant, allows the owner", async () => {
    expect(await resolveAgentForWorkspace("acme-private", tenantAgent as never, "ws-other")).toBeNull();
    const owned = await resolveAgentForWorkspace("acme-private", tenantAgent as never, "ws-acme");
    expect(owned?.source).toBe("owned");
  });
});

describe("config-store null-workspace filters", () => {
  it("getAgentConfigById(id, null) only matches rows with no workspace", async () => {
    await getAgentConfigById("acme-private", null);
    const [sql, params] = query.mock.calls.at(-1)!;
    expect(sql).toContain("workspace_id IS NULL");
    expect(params).toEqual(["acme-private"]);
  });

  it("getAgentConfigById(id, ws) filters by that workspace", async () => {
    await getAgentConfigById("acme-private", "ws-other");
    const [sql, params] = query.mock.calls.at(-1)!;
    expect(sql).toContain("workspace_id = $2");
    expect(params).toEqual(["acme-private", "ws-other"]);
  });

  it("a failed scoped delete does not evict the agent from the runtime registry", async () => {
    const deleted = await deleteAgentConfig("acme-private", null);
    expect(deleted).toBe(false);
    expect(query.mock.calls.at(-1)![0]).toContain("workspace_id IS NULL");
    expect(registry.has("acme-private")).toBe(true);
  });
});

describe("authorizeAgentRun (HTTP chat, /ws and /playground/ws share this)", () => {
  it("hides another tenant's agent from a caller with no workspace", async () => {
    const d = await authorizeAgentRun("mallory", "acme-private", null);
    expect(d).toMatchObject({ ok: false, status: 404 });
  });

  it("rejects a workspace the caller is not a member of", async () => {
    getMemberRole.mockResolvedValue(null);
    const d = await authorizeAgentRun("mallory", "acme-private", "ws-acme");
    expect(d).toMatchObject({ ok: false, status: 403 });
  });

  it("rejects read-only viewers", async () => {
    getMemberRole.mockResolvedValue("viewer");
    const d = await authorizeAgentRun("vic", "acme-private", "ws-acme");
    expect(d).toMatchObject({ ok: false, status: 403 });
  });

  it("allows a member of the owning workspace", async () => {
    getMemberRole.mockResolvedValue("member");
    const d = await authorizeAgentRun("alice", "acme-private", "ws-acme");
    expect(d.ok).toBe(true);
  });

  it("enforces workspace allowed_providers", async () => {
    getMemberRole.mockResolvedValue("member");
    query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith("SELECT workspace_id FROM agent_configs")) {
        return { rows: [{ workspace_id: owners[params[0] as string] }] };
      }
      if (sql.includes("FROM workspaces")) return { rows: [{ allowed_providers: ["claude"], allowed_models: null }] };
      return { rows: [] };
    });
    const d = await authorizeAgentRun("alice", "acme-private", "ws-acme");
    expect(d).toMatchObject({ ok: false, status: 403 });
  });

  it("enforces the token budget and applies the degraded model", async () => {
    checkTokenBudget.mockResolvedValue({ allowed: false });
    expect(await authorizeAgentRun("bob", "assistant", null)).toMatchObject({ ok: false, status: 429 });

    checkTokenBudget.mockResolvedValue({ allowed: true, degraded: true, overrideModel: "cheap-model" });
    const d = await authorizeAgentRun("bob", "assistant", null);
    expect(d.ok && d.config.model.modelId).toBe("cheap-model");
  });

  it("fails closed when a lookup throws", async () => {
    query.mockRejectedValue(new Error("db down"));
    const d = await authorizeAgentRun("bob", "assistant", null);
    expect(d).toMatchObject({ ok: false, status: 503 });
  });
});
