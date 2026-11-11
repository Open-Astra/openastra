import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPool } = vi.hoisted(() => ({
  mockPool: { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
}));

vi.mock("../../src/config/postgres.js", () => ({ getPool: () => mockPool }));
vi.mock("../../src/utils/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), dim: vi.fn(), active: vi.fn() }),
}));
vi.mock("../../src/memory/embeddings.js", () => ({
  generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
}));

import {
  getSemanticCache,
  getStaleSemanticCache,
  setSemanticCache,
} from "../../src/cache/semantic.js";
import { withSemanticCache } from "../../src/inference/semantic-cache-layer.js";
import type { InferenceClient } from "../../src/inference/types.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("semantic cache tenant scoping", () => {
  it("writes uid and workspace_id with every entry", async () => {
    await setSemanticCache("q", "answer", "agent-1", { uid: "alice", workspaceId: "ws-a" });
    const [sql, params] = mockPool.query.mock.calls[0]! as [string, unknown[]];
    expect(sql).toMatch(/uid, workspace_id\)/);
    expect(params.slice(-2)).toEqual(["alice", "ws-a"]);
  });

  it("filters lookups by uid and workspace, not just agent", async () => {
    await setSemanticCache("q", "answer", "agent-1", { uid: "alice", workspaceId: "ws-a" }); // marks bloom
    mockPool.query.mockClear();
    await getSemanticCache("q", "agent-1", { uid: "bob", workspaceId: "ws-b" });
    const [sql, params] = mockPool.query.mock.calls[0]! as [string, unknown[]];
    expect(sql).toMatch(/uid = \$2/);
    expect(sql).toMatch(/workspace_id IS NOT DISTINCT FROM \$3/);
    expect(params.slice(0, 3)).toEqual(["agent-1", "bob", "ws-b"]);
  });

  it("personal (no-workspace) entries are scoped to NULL workspace", async () => {
    await getStaleSemanticCache("q", "agent-1", 1000, { uid: "alice" });
    const params = mockPool.query.mock.calls[0]![1] as unknown[];
    expect(params.slice(0, 3)).toEqual(["agent-1", "alice", null]);
  });

  it("is a no-op without a uid — never reads or writes unscoped", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const noScope = undefined as any;
    await setSemanticCache("q", "answer", "agent-1", noScope);
    await setSemanticCache("q", "answer", "agent-1", { uid: "" });
    expect(await getSemanticCache("q", "agent-1", noScope)).toBeNull();
    expect(await getStaleSemanticCache("q", "agent-1", 1000, { uid: "" })).toBeNull();
    expect(mockPool.query).not.toHaveBeenCalled();
  });
});

describe("inference-level cache layer", () => {
  const response = { content: "fresh", toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop" as const };

  it("bypasses the cache entirely when the request carries no scope", async () => {
    const inner: InferenceClient = { chat: vi.fn().mockResolvedValue(response), async *chatStream() {} };
    const client = withSemanticCache(inner);
    await client.chat({ messages: [{ role: "user", content: "summarize my notes" }] });
    expect(inner.chat).toHaveBeenCalledOnce();
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it("uses the request's agent/uid/workspace when a scope is present", async () => {
    const inner: InferenceClient = { chat: vi.fn().mockResolvedValue(response), async *chatStream() {} };
    const client = withSemanticCache(inner);
    await client.chat({
      messages: [{ role: "user", content: "summarize my notes" }],
      cacheScope: { agentId: "agent-9", uid: "alice", workspaceId: "ws-a" },
    });
    const lookup = mockPool.query.mock.calls[0]![1] as unknown[];
    expect(lookup.slice(0, 3)).toEqual(["agent-9", "alice", "ws-a"]);
  });
});
