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

import {
  resolveSession,
  persistMessage,
  sessionKeyString,
  resetSession,
} from "../../src/sessions/store.js";
import type { SessionKey, SessionDoc, MessageDoc } from "../../src/sessions/types.js";
import type { AgentConfig } from "../../src/agents/types.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeKey(overrides: Partial<SessionKey> = {}): SessionKey {
  return {
    uid: "user-1",
    surface: "chat",
    surfaceId: "main",
    ...overrides,
  };
}

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "agent-1",
    name: "Test Agent",
    description: "",
    systemPromptTemplate: "You are a test agent.",
    model: {
      provider: "openai" as const,
      modelId: "gpt-4o",
      temperature: 0.7,
      maxOutputTokens: 2048,
    },
    tools: { allow: [], deny: [], maxToolCallsPerRound: 5 },
    session: { idleTimeoutMinutes: 60, dailyResetHour: 0 },
    spawn: { enabled: false, allowedTargets: [], maxDepth: 2 },
    memory: { enabled: false, autoSave: false },
    skills: [],
    tags: [],
    ...overrides,
  } as unknown as AgentConfig;
}

// A DB row that looks like an active session
function makeSessionRow(overrides: Partial<{
  id: string;
  agent_id: string;
  created_at: string;
  last_active_at: string;
  message_count: number;
  token_count: number;
  status: string;
  compaction_summary: string | null;
  webhook_url: string | null;
}> = {}) {
  const now = new Date().toISOString();
  return {
    id: "sess-existing",
    agent_id: "agent-1",
    created_at: now,
    last_active_at: now,
    message_count: 5,
    token_count: 100,
    status: "active",
    compaction_summary: null,
    webhook_url: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPool.query.mockResolvedValue({ rows: [] });
});

// ── Tests ────────────────────────────────────────────────────────────

describe("sessionKeyString", () => {
  it("formats correctly as surface:surfaceId", () => {
    expect(sessionKeyString({ uid: "u1", surface: "chat", surfaceId: "main" })).toBe("chat:main");
    expect(sessionKeyString({ uid: "u1", surface: "group", surfaceId: "room-42" })).toBe("group:room-42");
    expect(sessionKeyString({ uid: "u1", surface: "prop", surfaceId: "p-99" })).toBe("prop:p-99");
  });
});

describe("resolveSession — creates new session when none exists", () => {
  it("returns isNew=true and empty messages when no existing session found", async () => {
    // First query (SELECT sessions) returns no rows → create new session
    mockPool.query.mockResolvedValue({ rows: [] });

    const result = await resolveSession(makeKey(), makeAgentConfig());

    expect(result.isNew).toBe(true);
    expect(result.messages).toEqual([]);
    expect(result.session.agentId).toBe("agent-1");
    expect(result.session.status).toBe("active");
    expect(result.session.id).toBeDefined();

    // Should have called INSERT sessions
    const insertCall = mockPool.query.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("INSERT INTO sessions"),
    );
    expect(insertCall).toBeDefined();
  });
});

describe("resolveSession — returns existing active session", () => {
  it("returns isNew=false and loads messages when an active session exists", async () => {
    const row = makeSessionRow();
    const messageRow = {
      id: "msg-1",
      role: "user",
      content: "Hello",
      tool_calls: null,
      tool_call_id: null,
      token_estimate: 5,
      timestamp: String(Date.now()),
    };

    // Query order: SELECT sessions → returns row; SELECT messages → returns messageRow;
    // UPDATE last_active_at → no rows
    mockPool.query
      .mockResolvedValueOnce({ rows: [row] })      // session SELECT
      .mockResolvedValueOnce({ rows: [messageRow] }) // messages SELECT
      .mockResolvedValueOnce({ rows: [] });           // UPDATE last_active_at

    const result = await resolveSession(makeKey(), makeAgentConfig());

    expect(result.isNew).toBe(false);
    expect(result.session.id).toBe("sess-existing");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.content).toBe("Hello");
    expect(result.messages[0]!.role).toBe("user");
  });
});

describe("resolveSession — idle timeout triggers reset", () => {
  it("archives old session and creates new one when idleTimeout exceeded", async () => {
    // last_active_at is 2 hours ago, idleTimeoutMinutes=60 → should reset
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const row = makeSessionRow({ last_active_at: twoHoursAgo });

    // First call: SELECT sessions returns stale row
    // Then: UPDATE sessions SET status='archived', then INSERT new session
    mockPool.query
      .mockResolvedValueOnce({ rows: [row] })  // SELECT sessions
      .mockResolvedValueOnce({ rows: [] })      // UPDATE archived
      .mockResolvedValueOnce({ rows: [] });     // INSERT new session

    const result = await resolveSession(makeKey(), makeAgentConfig());

    expect(result.isNew).toBe(true);

    // Verify archive UPDATE was called
    const archiveCall = mockPool.query.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("UPDATE sessions") &&
        (c[0] as string).includes("archived"),
    );
    expect(archiveCall).toBeDefined();
  });
});

describe("resolveSession — daily reset triggers new session", () => {
  it("archives old session and creates new when lastActive is before today's reset hour", async () => {
    // lastActiveAt is yesterday
    const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const row = makeSessionRow({ last_active_at: yesterday });

    // Agent resets at hour 0 (midnight) → yesterday < today midnight → should reset
    const agentConfig = makeAgentConfig({
      session: { idleTimeoutMinutes: 999, dailyResetHour: 0 },
    } as Partial<AgentConfig>);

    mockPool.query
      .mockResolvedValueOnce({ rows: [row] }) // SELECT sessions
      .mockResolvedValueOnce({ rows: [] })     // UPDATE archived
      .mockResolvedValueOnce({ rows: [] });    // INSERT new session

    const result = await resolveSession(makeKey(), agentConfig);
    expect(result.isNew).toBe(true);
  });
});

describe("resolveSession — group session uses workspace_id", () => {
  it("queries by surface+surfaceId+workspaceId for group surface", async () => {
    mockPool.query.mockResolvedValue({ rows: [] });
    const key = makeKey({ surface: "group", surfaceId: "room-1" });

    await resolveSession(key, makeAgentConfig(), "ws-abc");

    // The SELECT query should include workspace_id as a param
    const selectCall = mockPool.query.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("SELECT") &&
        (c[0] as string).includes("sessions") &&
        Array.isArray(c[1]) &&
        (c[1] as unknown[]).includes("ws-abc"),
    );
    expect(selectCall).toBeDefined();
    // Params should be [surface, surfaceId, workspaceId]
    const params = selectCall![1] as string[];
    expect(params).toContain("group");
    expect(params).toContain("room-1");
    expect(params).toContain("ws-abc");
  });

  it("queries by uid+surface+surfaceId for non-group surface", async () => {
    mockPool.query.mockResolvedValue({ rows: [] });
    const key = makeKey({ surface: "chat", surfaceId: "main" });

    await resolveSession(key, makeAgentConfig(), "ws-xyz");

    const selectCall = mockPool.query.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("SELECT") &&
        (c[0] as string).includes("sessions") &&
        Array.isArray(c[1]) &&
        (c[1] as unknown[]).includes("user-1"),
    );
    expect(selectCall).toBeDefined();
    const params = selectCall![1] as string[];
    expect(params[0]).toBe("user-1");
    expect(params).toContain("chat");
    expect(params).toContain("main");
  });
});

describe("persistMessage", () => {
  it("returns MessageDoc with generated id", async () => {
    const msg: Omit<MessageDoc, "id"> = {
      role: "user",
      content: "Test message",
      tokenEstimate: 10,
      timestamp: Date.now(),
    };

    const result = await persistMessage("uid-1", "sess-1", msg);

    expect(result.id).toBeDefined();
    expect(typeof result.id).toBe("string");
    expect(result.role).toBe("user");
    expect(result.content).toBe("Test message");
    expect(result.tokenEstimate).toBe(10);
  });

  it("inserts message into DB with correct fields", async () => {
    const ts = Date.now();
    const msg: Omit<MessageDoc, "id"> = {
      role: "assistant",
      content: "Assistant reply",
      tokenEstimate: 25,
      timestamp: ts,
    };

    await persistMessage("uid-1", "sess-1", msg);

    const insertCall = mockPool.query.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("INSERT INTO messages"),
    );
    expect(insertCall).toBeDefined();

    const params = insertCall![1] as unknown[];
    // params[0] = id (uuid), [1] = sessionId, [2] = role, [3] = content
    expect(params[1]).toBe("sess-1");
    expect(params[2]).toBe("assistant");
    expect(params[3]).toBe("Assistant reply");
    expect(params[6]).toBe(25); // tokenEstimate
    expect(params[7]).toBe(ts); // timestamp
  });

  it("updates session message_count after inserting", async () => {
    const msg: Omit<MessageDoc, "id"> = {
      role: "user",
      content: "hi",
      tokenEstimate: 5,
      timestamp: Date.now(),
    };

    await persistMessage("uid-1", "sess-1", msg);

    const updateCall = mockPool.query.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("UPDATE sessions") &&
        (c[0] as string).includes("message_count"),
    );
    expect(updateCall).toBeDefined();
  });
});
