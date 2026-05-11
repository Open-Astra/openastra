import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const { mockPool, mockBus } = vi.hoisted(() => {
  const pool = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    connect: vi.fn().mockResolvedValue({ query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() }),
    end: vi.fn(),
    on: vi.fn(),
    totalCount: 1,
    idleCount: 1,
    waitingCount: 0,
  };
  const bus = {
    emit: vi.fn(),
    on: vi.fn().mockReturnValue(() => {}),
    once: vi.fn().mockReturnValue(() => {}),
    off: vi.fn(),
    onAny: vi.fn().mockReturnValue(() => {}),
    clear: vi.fn(),
    listenerCount: vi.fn().mockReturnValue(0),
  };
  return { mockPool: pool, mockBus: bus };
});

vi.mock("../../src/config/postgres.js", () => ({
  getPool: () => mockPool,
}));

vi.mock("../../src/events/index.js", () => ({
  getEventBus: vi.fn().mockReturnValue(mockBus),
}));

vi.mock("../../src/agents/audit.js", () => ({
  logAgentAction: vi.fn().mockResolvedValue("audit-id"),
}));

import {
  requestApproval,
  resolveApproval,
  needsApproval,
  DEFAULT_APPROVAL_POLICY,
  type ApprovalPolicy,
} from "../../src/agents/approval.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockPool.query.mockResolvedValue({ rows: [] });
  mockBus.emit.mockReturnValue(undefined);
});

afterEach(() => {
  vi.clearAllTimers();
});

describe("approval.ts — requestApproval", () => {
  it("auto-approves actions in the autoApprove list without waiting", async () => {
    const result = await requestApproval(
      "uid-1",
      "agent-1",
      "sess-1",
      "memory_write", // in DEFAULT_APPROVAL_POLICY.autoApprove
      "Writing to memory",
      {},
      DEFAULT_APPROVAL_POLICY,
    );

    expect(result.approved).toBe(true);
    expect(result.requestId).toBeDefined();
    // Should persist auto_approved record
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO approval_requests"),
      expect.arrayContaining(["auto_approved"]),
    );
    // Should NOT emit approval.requested (no waiting needed)
    const emitCalls = mockBus.emit.mock.calls.map((c: unknown[]) => c[0]);
    expect(emitCalls).not.toContain("approval.requested");
  });

  it("actions not in requireApproval list are allowed by default", async () => {
    const result = await requestApproval(
      "uid-1",
      "agent-1",
      "sess-1",
      "send_message", // not in requireApproval, not in autoApprove
      "Sending message",
      {},
      DEFAULT_APPROVAL_POLICY,
    );

    expect(result.approved).toBe(true);
    // No DB insert or event for actions that skip both lists
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it("required action emits approval.requested event", async () => {
    // Use a very short timeout so the test completes quickly without fake timers
    const policy: ApprovalPolicy = { ...DEFAULT_APPROVAL_POLICY, timeoutMs: 50, defaultOnTimeout: "deny" };

    // Don't await — just start the request and let it time out on its own
    const promise = requestApproval(
      "uid-1",
      "agent-1",
      "sess-1",
      "shell_execute", // in DEFAULT_APPROVAL_POLICY.requireApproval
      "Execute shell command",
      { command: "ls" },
      policy,
    );

    // The bus.emit("approval.requested") is called before the internal setTimeout/Promise,
    // so we need to wait for the persistApproval (pool.query) to complete first.
    // pool.query is already mocked to resolve immediately; await a few microtask ticks.
    await new Promise((r) => setImmediate(r));

    const emitCalls = mockBus.emit.mock.calls.map((c: unknown[]) => c[0]);
    expect(emitCalls).toContain("approval.requested");

    const requestedPayload = mockBus.emit.mock.calls.find(
      (c: unknown[]) => c[0] === "approval.requested",
    )?.[1] as Record<string, unknown>;
    expect(requestedPayload).toMatchObject({
      uid: "uid-1",
      agentId: "agent-1",
      sessionId: "sess-1",
      action: "shell_execute",
      description: "Execute shell command",
    });

    // Wait for the natural timeout to complete
    await promise;
  });

  it("timeout with defaultOnTimeout=deny resolves as rejected", async () => {
    vi.useFakeTimers();

    const policy: ApprovalPolicy = {
      ...DEFAULT_APPROVAL_POLICY,
      timeoutMs: 1000,
      defaultOnTimeout: "deny",
    };

    const promise = requestApproval(
      "uid-1",
      "agent-1",
      "sess-1",
      "shell_execute",
      "Run shell",
      {},
      policy,
    );

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.approved).toBe(false);
    vi.useRealTimers();
  });

  it("timeout with defaultOnTimeout=approve resolves as approved", async () => {
    vi.useFakeTimers();

    const policy: ApprovalPolicy = {
      ...DEFAULT_APPROVAL_POLICY,
      timeoutMs: 1000,
      defaultOnTimeout: "approve",
    };

    const promise = requestApproval(
      "uid-1",
      "agent-1",
      "sess-1",
      "agent_spawn",
      "Spawn sub-agent",
      {},
      policy,
    );

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.approved).toBe(true);
    vi.useRealTimers();
  });

  it("resolveApproval — approved status triggers resolution and emits event", async () => {
    // Use a long timeout — we'll resolve manually before it fires
    const policy: ApprovalPolicy = {
      ...DEFAULT_APPROVAL_POLICY,
      timeoutMs: 30000,
    };

    const requestPromise = requestApproval(
      "uid-1",
      "agent-1",
      "sess-1",
      "shell_execute",
      "Run a command",
      {},
      policy,
    );

    // Wait for persistApproval + bus.emit to complete (all async mocks resolve immediately)
    await new Promise((r) => setImmediate(r));

    // Grab the requestId from the emitted event
    const requestedCall = mockBus.emit.mock.calls.find(
      (c: unknown[]) => c[0] === "approval.requested",
    );
    const requestId = (requestedCall?.[1] as Record<string, unknown>)?.requestId as string;
    expect(requestId).toBeDefined();

    // Resolve it as approved — calls pending.resolve() which settles requestPromise immediately
    const approved = await resolveApproval(requestId, "approved", "user-1");
    expect(approved).toBe(true);

    const result = await requestPromise;
    expect(result.approved).toBe(true);
    expect(result.requestId).toBe(requestId);

    const emitCalls = mockBus.emit.mock.calls.map((c: unknown[]) => c[0]);
    expect(emitCalls).toContain("approval.resolved");
  });

  it("resolveApproval — denied status resolves as false", async () => {
    const requestPromise = requestApproval(
      "uid-2",
      "agent-2",
      "sess-2",
      "financial_action",
      "Process payment",
      { amount: 100 },
      { ...DEFAULT_APPROVAL_POLICY, timeoutMs: 30000 },
    );

    await new Promise((r) => setImmediate(r));

    const requestedCall = mockBus.emit.mock.calls.find(
      (c: unknown[]) => c[0] === "approval.requested",
    );
    const requestId = (requestedCall?.[1] as Record<string, unknown>)?.requestId as string;
    expect(requestId).toBeDefined();

    const approved = await resolveApproval(requestId, "denied", "user-2", "Not authorized");
    expect(approved).toBe(false);

    const result = await requestPromise;
    expect(result.approved).toBe(false);
  });

  it("needsApproval — returns true for required actions, false otherwise", () => {
    expect(needsApproval("shell_execute", DEFAULT_APPROVAL_POLICY)).toBe(true);
    expect(needsApproval("financial_action", DEFAULT_APPROVAL_POLICY)).toBe(true);
    expect(needsApproval("agent_spawn", DEFAULT_APPROVAL_POLICY)).toBe(true);
    expect(needsApproval("memory_write", DEFAULT_APPROVAL_POLICY)).toBe(false);
    expect(needsApproval("send_message", DEFAULT_APPROVAL_POLICY)).toBe(false);
  });
});
