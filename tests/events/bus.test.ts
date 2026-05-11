import { vi, describe, it, expect, beforeEach } from "vitest";
import { EventBus } from "../../src/events/bus.js";

// EventBus is pure logic (wraps Node's EventEmitter) — no external mocks needed.
// We test by directly instantiating EventBus.

// Set NODE_ENV=production to suppress dev-mode Zod validation noise in these tests
// (we test correct payloads, not validation errors).
process.env.NODE_ENV = "production";

let bus: EventBus;

beforeEach(() => {
  bus = new EventBus();
});

// ── Helper payloads ──────────────────────────────────────────────────

function makeMemoryWrittenPayload() {
  return {
    uid: "user-1",
    category: "note",
    content: "some content",
    timestamp: Date.now(),
  };
}

function makeAgentStartedPayload() {
  return {
    uid: "user-1",
    agentId: "agent-1",
    sessionId: "sess-1",
    timestamp: Date.now(),
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("EventBus — emit + on", () => {
  it("handler receives the emitted payload", async () => {
    const handler = vi.fn();
    bus.on("memory.written", handler);

    const payload = makeMemoryWrittenPayload();
    bus.emit("memory.written", payload);

    // on() wraps in Promise.resolve so we need a tick
    await new Promise((r) => setImmediate(r));
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(payload);
  });

  it("multiple handlers for same event all fire", async () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    const h3 = vi.fn();

    bus.on("agent.started", h1);
    bus.on("agent.started", h2);
    bus.on("agent.started", h3);

    const payload = makeAgentStartedPayload();
    bus.emit("agent.started", payload);

    await new Promise((r) => setImmediate(r));
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
    expect(h3).toHaveBeenCalledOnce();
  });
});

describe("EventBus — off", () => {
  it("off via unsubscribe function stops handler from receiving events", async () => {
    const handler = vi.fn();
    const unsubscribe = bus.on("memory.written", handler);

    unsubscribe();
    bus.emit("memory.written", makeMemoryWrittenPayload());

    await new Promise((r) => setImmediate(r));
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("EventBus — once", () => {
  it("once handler fires exactly once then auto-removes", async () => {
    const handler = vi.fn();
    bus.once("agent.started", handler);

    const payload = makeAgentStartedPayload();
    bus.emit("agent.started", payload);
    bus.emit("agent.started", payload);
    bus.emit("agent.started", payload);

    await new Promise((r) => setImmediate(r));
    expect(handler).toHaveBeenCalledOnce();
  });

  it("once unsubscribe function removes handler before it fires", async () => {
    const handler = vi.fn();
    const unsubscribe = bus.once("agent.started", handler);

    unsubscribe();
    bus.emit("agent.started", makeAgentStartedPayload());

    await new Promise((r) => setImmediate(r));
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("EventBus — onAny (wildcard)", () => {
  it("wildcard handler receives all events with their names", async () => {
    const wildcardHandler = vi.fn();
    bus.onAny(wildcardHandler);

    const memPayload = makeMemoryWrittenPayload();
    const agentPayload = makeAgentStartedPayload();

    bus.emit("memory.written", memPayload);
    bus.emit("agent.started", agentPayload);

    await new Promise((r) => setImmediate(r));
    expect(wildcardHandler).toHaveBeenCalledTimes(2);

    const calls = wildcardHandler.mock.calls;
    expect(calls[0]![0]).toBe("memory.written");
    expect(calls[0]![1]).toEqual(memPayload);
    expect(calls[1]![0]).toBe("agent.started");
    expect(calls[1]![1]).toEqual(agentPayload);
  });

  it("wildcard unsubscribe stops receiving events", async () => {
    const wildcardHandler = vi.fn();
    const unsubscribe = bus.onAny(wildcardHandler);

    unsubscribe();
    bus.emit("memory.written", makeMemoryWrittenPayload());

    await new Promise((r) => setImmediate(r));
    expect(wildcardHandler).not.toHaveBeenCalled();
  });
});

describe("EventBus — clear", () => {
  it("clear removes all listeners so no handlers fire", async () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    const wildcard = vi.fn();

    bus.on("memory.written", h1);
    bus.on("agent.started", h2);
    bus.onAny(wildcard);

    bus.clear();

    bus.emit("memory.written", makeMemoryWrittenPayload());
    bus.emit("agent.started", makeAgentStartedPayload());

    await new Promise((r) => setImmediate(r));
    expect(h1).not.toHaveBeenCalled();
    expect(h2).not.toHaveBeenCalled();
    expect(wildcard).not.toHaveBeenCalled();
  });
});

describe("EventBus — listenerCount", () => {
  it("returns correct count for a specific event", () => {
    expect(bus.listenerCount("memory.written")).toBe(0);

    const u1 = bus.on("memory.written", vi.fn());
    expect(bus.listenerCount("memory.written")).toBe(1);

    bus.on("memory.written", vi.fn());
    expect(bus.listenerCount("memory.written")).toBe(2);

    u1(); // unsubscribe first handler
    expect(bus.listenerCount("memory.written")).toBe(1);
  });
});

describe("EventBus — error isolation", () => {
  it("async handler rejection is caught and does not prevent other handlers from firing", async () => {
    // The bus uses Promise.resolve(handler(payload)).catch() — this catches async rejections.
    // A handler that returns a rejected promise is safely caught; the next handler still fires.
    const asyncThrower = vi.fn().mockRejectedValue(new Error("async error"));
    const safe = vi.fn();

    bus.on("agent.started", asyncThrower);
    bus.on("agent.started", safe);

    bus.emit("agent.started", makeAgentStartedPayload());

    await new Promise((r) => setImmediate(r));
    expect(asyncThrower).toHaveBeenCalledOnce();
    expect(safe).toHaveBeenCalledOnce();
  });

  it("bus remains usable after a handler throws asynchronously", async () => {
    const asyncThrower = vi.fn().mockRejectedValue(new Error("crash"));
    bus.on("memory.written", asyncThrower);

    // Emit once (causes async rejection that is caught internally)
    bus.emit("memory.written", makeMemoryWrittenPayload());
    await new Promise((r) => setImmediate(r));

    // Bus should still work — a new handler registered after the error fires normally
    const newHandler = vi.fn();
    bus.on("agent.started", newHandler);
    bus.emit("agent.started", makeAgentStartedPayload());

    await new Promise((r) => setImmediate(r));
    expect(newHandler).toHaveBeenCalledOnce();
  });
});
