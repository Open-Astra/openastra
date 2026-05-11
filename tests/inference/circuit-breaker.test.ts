import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

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

vi.mock("../../src/utils/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    dim: vi.fn(),
    active: vi.fn(),
  }),
}));

import {
  CircuitBreaker,
  getCircuitBreaker,
  getCircuitBreakerStatus,
  getAllCircuitBreakerStates,
} from "../../src/inference/circuit-breaker.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeSuccessFn<T>(value: T) {
  return vi.fn().mockResolvedValue(value);
}

function makeFailingFn(message = "Provider error") {
  return vi.fn().mockRejectedValue(new Error(message));
}

function makeCB(opts?: { failureThreshold?: number; successThreshold?: number; timeoutMs?: number; windowMs?: number }) {
  return new CircuitBreaker("test-provider", {
    failureThreshold: opts?.failureThreshold ?? 3,
    successThreshold: opts?.successThreshold ?? 2,
    timeoutMs: opts?.timeoutMs ?? 1000,
    windowMs: opts?.windowMs ?? 60_000,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mockPool.query.mockResolvedValue({ rows: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Tests ────────────────────────────────────────────────────────────

describe("CircuitBreaker", () => {
  it("starts in closed state", () => {
    const cb = makeCB();
    const state = cb.getState();
    expect(state.state).toBe("closed");
    expect(state.totalRequests).toBe(0);
    expect(state.totalSuccesses).toBe(0);
    expect(state.lastFailureAt).toBeNull();
  });

  it("successful calls in closed state increment totalRequests and totalSuccesses", async () => {
    const cb = makeCB();
    const fn = makeSuccessFn("ok");

    await cb.execute(fn);
    await cb.execute(fn);

    const state = cb.getState();
    expect(state.totalRequests).toBe(2);
    expect(state.totalSuccesses).toBe(2);
    expect(state.state).toBe("closed");
  });

  it("transitions to open after hitting failure threshold", async () => {
    const cb = makeCB({ failureThreshold: 3 });
    const fn = makeFailingFn("boom");

    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(fn)).rejects.toThrow("boom");
    }

    expect(cb.getState().state).toBe("open");
    expect(cb.isOpen).toBe(true);
  });

  it("open state rejects calls immediately without invoking the function", async () => {
    const cb = makeCB({ failureThreshold: 2 });
    const failFn = makeFailingFn("initial failure");

    // Trip the breaker
    await expect(cb.execute(failFn)).rejects.toThrow();
    await expect(cb.execute(failFn)).rejects.toThrow();
    expect(cb.getState().state).toBe("open");

    // Now in open state — a new fn should NOT be called
    const newFn = makeSuccessFn("should not run");
    await expect(cb.execute(newFn)).rejects.toThrow("is OPEN — fast failing");
    expect(newFn).not.toHaveBeenCalled();
  });

  it("transitions to half-open after cooldown period elapses", async () => {
    const cb = makeCB({ failureThreshold: 2, timeoutMs: 5000 });
    const failFn = makeFailingFn();

    await expect(cb.execute(failFn)).rejects.toThrow();
    await expect(cb.execute(failFn)).rejects.toThrow();
    expect(cb.getState().state).toBe("open");

    // Advance past cooldown
    vi.advanceTimersByTime(6000);

    // Next call should attempt (half-open) — use a success fn
    const successFn = makeSuccessFn("recovered");
    // First call transitions to half-open and attempts the fn
    await cb.execute(successFn);
    expect(successFn).toHaveBeenCalledOnce();
  });

  it("successful call in half-open returns to closed after successThreshold met", async () => {
    const cb = makeCB({ failureThreshold: 2, timeoutMs: 1000, successThreshold: 2 });
    const failFn = makeFailingFn();

    // Open the breaker
    await expect(cb.execute(failFn)).rejects.toThrow();
    await expect(cb.execute(failFn)).rejects.toThrow();

    // Advance past cooldown to enable half-open on next call
    vi.advanceTimersByTime(2000);

    const successFn = makeSuccessFn("ok");
    // First success in half-open: consecutiveSuccesses = 1, still half-open
    await cb.execute(successFn);
    expect(cb.getState().state).toBe("half-open");

    // Second success in half-open: consecutiveSuccesses = 2 >= threshold → closed
    await cb.execute(successFn);
    expect(cb.getState().state).toBe("closed");
  });

  it("failed call in half-open returns immediately to open", async () => {
    const cb = makeCB({ failureThreshold: 2, timeoutMs: 1000, successThreshold: 2 });
    const failFn = makeFailingFn("fail");

    // Open the breaker
    await expect(cb.execute(failFn)).rejects.toThrow();
    await expect(cb.execute(failFn)).rejects.toThrow();

    // Advance past cooldown → next execute transitions to half-open
    vi.advanceTimersByTime(2000);

    // Fail in half-open → should go back to open
    await expect(cb.execute(failFn)).rejects.toThrow("fail");
    expect(cb.getState().state).toBe("open");
  });

  it("per-provider isolation — tripped provider does not affect another", async () => {
    const cbA = new CircuitBreaker("provider-a", { failureThreshold: 2 });
    const cbB = new CircuitBreaker("provider-b", { failureThreshold: 2 });
    const failFn = makeFailingFn("a-error");

    // Trip provider-a
    await expect(cbA.execute(failFn)).rejects.toThrow();
    await expect(cbA.execute(failFn)).rejects.toThrow();
    expect(cbA.getState().state).toBe("open");

    // provider-b should still be closed
    const successFn = makeSuccessFn("b-ok");
    await cbB.execute(successFn);
    expect(cbB.getState().state).toBe("closed");
    expect(successFn).toHaveBeenCalled();
  });

  it("getState() returns correct telemetry including lastFailureAt", async () => {
    const cb = makeCB({ failureThreshold: 5 });
    const failFn = makeFailingFn("err");

    const before = Date.now();
    await expect(cb.execute(failFn)).rejects.toThrow();
    const after = Date.now();

    const state = cb.getState();
    expect(state.totalRequests).toBe(1);
    expect(state.totalSuccesses).toBe(0);
    expect(state.lastFailureAt).toBeGreaterThanOrEqual(before);
    expect(state.lastFailureAt).toBeLessThanOrEqual(after);
  });

  it("getAllCircuitBreakerStates returns registered breakers via getCircuitBreaker()", async () => {
    // Use the registry-level functions
    const cb1 = getCircuitBreaker("registry-provider-1");
    const cb2 = getCircuitBreaker("registry-provider-2");

    await cb1.execute(makeSuccessFn("ok"));
    await expect(cb2.execute(makeFailingFn("fail"))).rejects.toThrow();

    const allStates = getAllCircuitBreakerStates();
    expect(allStates["registry-provider-1"]).toBeDefined();
    expect(allStates["registry-provider-1"]!.state).toBe("closed");
    expect(allStates["registry-provider-2"]).toBeDefined();

    const statusMap = getCircuitBreakerStatus();
    expect(statusMap["registry-provider-1"]).toBe("closed");
    expect(statusMap["registry-provider-2"]).toBeDefined();
  });
});
