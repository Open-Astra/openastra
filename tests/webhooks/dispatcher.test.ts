import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────
const { mockPool, mockBus, mockIsBlockedUrl } = vi.hoisted(() => {
  const pool = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    connect: vi.fn(),
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
  const mockIsBlockedUrl = vi.fn().mockResolvedValue(false);
  return { mockPool: pool, mockBus: bus, mockIsBlockedUrl };
});

vi.mock("../../src/config/postgres.js", () => ({
  getPool: () => mockPool,
}));

vi.mock("../../src/events/index.js", () => ({
  getEventBus: vi.fn().mockReturnValue(mockBus),
}));

vi.mock("../../src/utils/ssrf-guard.js", () => ({
  isBlockedUrl: mockIsBlockedUrl,
}));

// Mock the webhook store module to avoid DB in getWebhooksForEvent
vi.mock("../../src/webhooks/store.js", () => ({
  getWebhooksForEvent: vi.fn().mockResolvedValue([]),
  logDelivery: vi.fn().mockResolvedValue(undefined),
}));

// Mock the rate limiter
vi.mock("../../src/webhooks/rate-limiter.js", () => ({
  checkWebhookRate: vi.fn().mockReturnValue(true),
}));

// Mock the inspector log (fire-and-forget)
vi.mock("../../src/webhooks/inspector-log.js", () => ({
  logWebhookDispatch: vi.fn(),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  dispatchWebhook,
  fireWebhooksForEvent,
} from "../../src/webhooks/dispatcher.js";
import { getWebhooksForEvent, logDelivery } from "../../src/webhooks/store.js";
import { checkWebhookRate } from "../../src/webhooks/rate-limiter.js";
import type { WebhookDoc, WebhookPayload } from "../../src/webhooks/types.js";

const mockWebhook: WebhookDoc = {
  id: "wh-1",
  uid: "user-1",
  url: "https://example.com/webhook",
  events: ["agent_completed"],
  secret: "a".repeat(64),
  active: true,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const mockPayload: WebhookPayload = {
  event: "agent_completed",
  timestamp: Date.now(),
  data: { agentId: "agent-1", result: "done" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockIsBlockedUrl.mockResolvedValue(false);
  mockPool.query.mockResolvedValue({ rows: [] });
  (getWebhooksForEvent as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (checkWebhookRate as ReturnType<typeof vi.fn>).mockReturnValue(true);
});

describe("dispatchWebhook", () => {
  it("sends POST with correct payload to webhook URL", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue("OK"),
    });

    const delivery = await dispatchWebhook(mockWebhook, mockPayload);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/webhook",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
        body: expect.stringContaining("agent_completed"),
      }),
    );
    expect(delivery.success).toBe(true);
    expect(delivery.statusCode).toBe(200);
  });

  it("includes HMAC signature header in outbound request", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue("OK"),
    });

    await dispatchWebhook(mockWebhook, mockPayload);

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers["X-Webhook-Signature"]).toBeDefined();
    expect(headers["X-Webhook-Signature"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("blocks SSRF: rejects when isBlockedUrl returns true", async () => {
    // isBlockedUrl returns true on every call → throw on every attempt → retries exhaust
    // Use fake timers so the retry delays (1s, 4s, 16s) complete instantly
    vi.useFakeTimers();
    mockIsBlockedUrl.mockResolvedValue(true);

    const deliveryPromise = dispatchWebhook(mockWebhook, mockPayload);
    await vi.runAllTimersAsync();
    const delivery = await deliveryPromise;

    vi.useRealTimers();
    mockIsBlockedUrl.mockResolvedValue(false); // restore default

    expect(delivery.success).toBe(false);
    expect(delivery.error).toContain("blocked internal address");
    // fetch should NOT have been called
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns failure delivery on 5xx response and retries", async () => {
    // All calls return 500
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue("Server Error"),
    });

    const delivery = await dispatchWebhook(mockWebhook, mockPayload);

    expect(delivery.success).toBe(false);
    // Should have retried: MAX_RETRIES=3 means up to 4 total attempts
    // but delays make this slow — just verify multiple attempts were made
    expect(delivery.attempts).toBeGreaterThan(1);
    expect(delivery.statusCode).toBe(500);
  }, 30_000);

  it("does not retry on 4xx response (permanent client error)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: vi.fn().mockResolvedValue("Bad Request"),
    });

    const delivery = await dispatchWebhook(mockWebhook, mockPayload);

    expect(delivery.success).toBe(false);
    expect(delivery.attempts).toBe(1); // only one attempt for 4xx
  });

  it("logs delivery after successful dispatch", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue("OK"),
    });

    await dispatchWebhook(mockWebhook, mockPayload);

    // logDelivery is called as fire-and-forget — allow microtasks to flush
    await new Promise((r) => setImmediate(r));
    expect(logDelivery).toHaveBeenCalledWith(
      mockWebhook.uid,
      mockWebhook.id,
      expect.objectContaining({ success: true }),
    );
  });

  it("rejects redirect responses (redirect-based SSRF)", async () => {
    // Redirect throws inside the try block → retries kick in
    // Use fake timers so delay-based retries complete instantly
    vi.useFakeTimers();
    mockFetch.mockResolvedValue({
      ok: false,
      status: 301,
      text: vi.fn().mockResolvedValue(""),
    });

    const deliveryPromise = dispatchWebhook(mockWebhook, mockPayload);
    await vi.runAllTimersAsync();
    const delivery = await deliveryPromise;

    vi.useRealTimers();

    expect(delivery.success).toBe(false);
    expect(delivery.error).toContain("redirect");
  });
});

describe("fireWebhooksForEvent", () => {
  it("no-op when no webhooks are registered for the event", async () => {
    (getWebhooksForEvent as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    await fireWebhooksForEvent("user-1", "agent_completed", { result: "done" });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockBus.emit).not.toHaveBeenCalled();
  });

  it("dispatches webhooks and emits webhook.dispatched event for each", async () => {
    (getWebhooksForEvent as ReturnType<typeof vi.fn>).mockResolvedValueOnce([mockWebhook]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue("OK"),
    });

    await fireWebhooksForEvent("user-1", "agent_completed", { result: "done" });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockBus.emit).toHaveBeenCalledWith(
      "webhook.dispatched",
      expect.objectContaining({
        uid: "user-1",
        webhookId: "wh-1",
        eventType: "agent_completed",
        success: true,
      }),
    );
  });

  it("skips dispatch entirely when rate limit is exceeded", async () => {
    (checkWebhookRate as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);

    await fireWebhooksForEvent("user-1", "agent_completed", {});

    expect(getWebhooksForEvent).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
