import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Tests for src/agents/config-store.ts ────────────────────────────

const { mockPool, mockRegisterAgentConfig, mockUnregisterAgentConfig } = vi.hoisted(() => {
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
    mockRegisterAgentConfig: vi.fn(),
    mockUnregisterAgentConfig: vi.fn(),
  };
});

vi.mock("../../src/config/postgres.js", () => ({
  getPool: () => mockPool,
}));

vi.mock("../../src/config/agents.js", () => ({
  registerAgentConfig: mockRegisterAgentConfig,
  unregisterAgentConfig: mockUnregisterAgentConfig,
  getAgentConfig: vi.fn(),
  getAllAgentConfigs: vi.fn().mockReturnValue(new Map()),
}));

import {
  getAgentConfigs,
  getAgentConfigById,
  createAgentConfig,
  updateAgentConfig,
  deleteAgentConfig,
  snapshotAgentVersion,
} from "../../src/agents/config-store.js";
import type { AgentConfig } from "../../src/agents/types.js";

// ── Helper ────────────────────────────────────────────────────────────

function makeAgentRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "agent-1",
    workspace_id: "ws-1",
    display_name: "Test Agent",
    tier: "free",
    model: { provider: "openai", modelId: "gpt-4o", maxContextTokens: 8000, maxOutputTokens: 2048, temperature: 0.7 },
    system_prompt: "You are a helpful assistant.",
    tools: { allow: ["web-search"], deny: [], maxToolCallsPerRound: 8 },
    skills: ["research"],
    session_config: { dailyResetHour: 4, idleTimeoutMinutes: 120, maxContextMessages: 50 },
    spawn_config: { enabled: false, allowedTargets: [], maxDepth: 2 },
    created_at: new Date("2026-01-01"),
    ...overrides,
  };
}

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "agent-1",
    displayName: "Test Agent",
    tier: "free",
    model: {
      provider: "openai",
      modelId: "gpt-4o",
      maxContextTokens: 8000,
      maxOutputTokens: 2048,
      temperature: 0.7,
    },
    systemPromptTemplate: "You are a helpful assistant.",
    tools: { allow: ["web-search"], deny: [], maxToolCallsPerRound: 8 },
    skills: ["research"],
    session: { dailyResetHour: 4, idleTimeoutMinutes: 120, maxContextMessages: 50 },
    spawn: { enabled: false, allowedTargets: [], maxDepth: 2 },
    fileAccess: { restricted: true, allowedPaths: [] },
    ...overrides,
  };
}

describe("getAgentConfigs", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns workspace agents from DB rows", async () => {
    mockPool.query.mockResolvedValue({ rows: [makeAgentRow()] });

    const configs = await getAgentConfigs("ws-1");

    expect(configs).toHaveLength(1);
    expect(configs[0].id).toBe("agent-1");
    expect(configs[0].displayName).toBe("Test Agent");
    expect(configs[0].tier).toBe("free");
  });

  it("returns empty array when no agents exist in workspace", async () => {
    mockPool.query.mockResolvedValue({ rows: [] });

    const configs = await getAgentConfigs("ws-empty");

    expect(configs).toEqual([]);
  });

  it("scopes query to the provided workspaceId", async () => {
    mockPool.query.mockResolvedValue({ rows: [] });

    await getAgentConfigs("ws-scoped");

    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toContain("workspace_id");
    expect(params).toContain("ws-scoped");
  });
});

describe("getAgentConfigById", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the agent when found by ID and workspaceId", async () => {
    mockPool.query.mockResolvedValue({ rows: [makeAgentRow()] });

    const config = await getAgentConfigById("agent-1", "ws-1");

    expect(config).not.toBeNull();
    expect(config?.id).toBe("agent-1");
  });

  it("returns null when agent is not found", async () => {
    mockPool.query.mockResolvedValue({ rows: [] });

    const config = await getAgentConfigById("nonexistent", "ws-1");

    expect(config).toBeNull();
  });

  it("queries without workspaceId when workspaceId is null", async () => {
    mockPool.query.mockResolvedValue({ rows: [makeAgentRow()] });

    await getAgentConfigById("agent-1", null);

    const [sql] = mockPool.query.mock.calls[0];
    // Should be a simpler query without workspace_id filter
    expect(sql).not.toContain("workspace_id");
  });
});

describe("createAgentConfig", () => {
  beforeEach(() => vi.clearAllMocks());

  it("inserts a new agent config into the DB", async () => {
    mockPool.query.mockResolvedValue({ rows: [{ version: 1 }] });

    const config = makeAgentConfig();
    await createAgentConfig(config, "ws-1", "user-creator");

    expect(mockPool.query).toHaveBeenCalled();
    const [sql] = mockPool.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO agent_configs");
  });

  it("registers the config in the in-memory runtime registry", async () => {
    mockPool.query.mockResolvedValue({ rows: [{ version: 1 }] });

    const config = makeAgentConfig();
    await createAgentConfig(config, "ws-1", "user-creator");

    expect(mockRegisterAgentConfig).toHaveBeenCalledWith("agent-1", config);
  });

  it("snapshots initial version (COALESCE MAX(version)+1 pattern)", async () => {
    // First call: INSERT into agent_configs, second call: snapshot version
    mockPool.query.mockResolvedValue({ rows: [{ version: 1 }] });

    const config = makeAgentConfig();
    await createAgentConfig(config, "ws-1", "user-creator");

    // Allow async snapshot to settle
    await new Promise(r => setTimeout(r, 10));

    // Should have called query at least twice (insert + snapshot)
    const allSqls = mockPool.query.mock.calls.map(([sql]: [string]) => sql);
    const hasSnapshot = allSqls.some((sql: string) => sql.includes("agent_config_versions"));
    expect(hasSnapshot).toBe(true);
  });
});

describe("updateAgentConfig", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updates display name and returns new config", async () => {
    const updatedRow = makeAgentRow({ display_name: "Updated Agent" });
    mockPool.query.mockResolvedValue({ rows: [updatedRow] });

    const result = await updateAgentConfig("agent-1", { displayName: "Updated Agent" });

    expect(result).not.toBeNull();
    expect(result?.displayName).toBe("Updated Agent");
  });

  it("returns null when agent not found", async () => {
    mockPool.query.mockResolvedValue({ rows: [] });

    const result = await updateAgentConfig("nonexistent", { displayName: "X" });

    expect(result).toBeNull();
  });

  it("scopes update to workspaceId when provided", async () => {
    const updatedRow = makeAgentRow();
    mockPool.query.mockResolvedValue({ rows: [updatedRow] });

    await updateAgentConfig("agent-1", { displayName: "X" }, "editor", "ws-scoped");

    const [sql] = mockPool.query.mock.calls[0];
    expect(sql).toContain("workspace_id");
  });
});

describe("deleteAgentConfig", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns true when agent is deleted successfully", async () => {
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 1 });

    const result = await deleteAgentConfig("agent-1", "ws-1");

    expect(result).toBe(true);
    expect(mockUnregisterAgentConfig).toHaveBeenCalledWith("agent-1");
  });

  it("returns false when agent does not exist", async () => {
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await deleteAgentConfig("nonexistent", "ws-1");

    expect(result).toBe(false);
  });
});

describe("snapshotAgentVersion", () => {
  beforeEach(() => vi.clearAllMocks());

  it("inserts a version row and returns the version number", async () => {
    mockPool.query.mockResolvedValue({ rows: [{ version: 3 }] });

    const config = makeAgentConfig();
    const version = await snapshotAgentVersion("agent-1", "ws-1", config, "user-1", "v3");

    expect(version).toBe(3);
    const [sql] = mockPool.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO agent_config_versions");
    expect(sql).toContain("COALESCE");
    expect(sql).toContain("MAX(version)");
  });

  it("passes label and createdBy to the INSERT", async () => {
    mockPool.query.mockResolvedValue({ rows: [{ version: 1 }] });

    const config = makeAgentConfig();
    await snapshotAgentVersion("agent-1", "ws-1", config, "user-abc", "my-label");

    const [, params] = mockPool.query.mock.calls[0];
    expect(params).toContain("my-label");
    expect(params).toContain("user-abc");
  });
});
