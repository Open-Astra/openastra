import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────
const { mockPool, mockIsBlockedUrl } = vi.hoisted(() => {
  const pool = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    connect: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
    totalCount: 1,
    idleCount: 1,
    waitingCount: 0,
  };
  const mockIsBlockedUrl = vi.fn().mockResolvedValue(false);
  return { mockPool: pool, mockIsBlockedUrl };
});

vi.mock("../../src/config/postgres.js", () => ({
  getPool: () => mockPool,
}));

vi.mock("../../src/utils/ssrf-guard.js", () => ({
  isBlockedUrl: mockIsBlockedUrl,
}));

vi.mock("../../src/utils/logger.js", () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock global fetch for alert webhook calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { checkSlos, checkAllWorkspaceSlos } from "../../src/observability/slo-monitor.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockPool.query.mockResolvedValue({ rows: [] });
  mockIsBlockedUrl.mockResolvedValue(false);
  mockFetch.mockResolvedValue({ ok: true, status: 200 });
});

describe("checkSlos", () => {
  it("loads SLO definitions for the given workspace", async () => {
    mockPool.query.mockResolvedValue({ rows: [] });

    await checkSlos("ws-1");

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("slo_definitions"),
      ["ws-1"],
    );
  });

  it("does nothing when no SLO definitions exist for workspace", async () => {
    mockPool.query.mockResolvedValue({ rows: [] });

    await checkSlos("ws-empty");

    // Only the initial SLO fetch query should be made
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("measures p95 latency and does not fire alert when within threshold", async () => {
    const sloRow = {
      id: "slo-1",
      agent_id: "agent-1",
      metric: "p95_latency_ms",
      threshold: 1000,
      window_minutes: 5,
      alert_webhook_url: null,
    };

    // First call: load SLOs; second call: get p95 metric (within threshold)
    mockPool.query
      .mockResolvedValueOnce({ rows: [sloRow] })     // slo_definitions
      .mockResolvedValueOnce({ rows: [{ p95: 500 }] }); // agent_traces p95 (under threshold)

    await checkSlos("ws-1");

    // No violation INSERT, no alert
    expect(mockPool.query).toHaveBeenCalledTimes(2);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("detects breach and records violation when measured value exceeds threshold", async () => {
    const sloRow = {
      id: "slo-2",
      agent_id: "agent-2",
      metric: "p95_latency_ms",
      threshold: 500,
      window_minutes: 10,
      alert_webhook_url: null,
    };

    mockPool.query
      .mockResolvedValueOnce({ rows: [sloRow] })
      .mockResolvedValueOnce({ rows: [{ p95: 1200 }] }) // exceeds 500ms threshold
      .mockResolvedValueOnce({ rows: [] }); // slo_violations INSERT

    await checkSlos("ws-2");

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("slo_violations"),
      ["slo-2", 1200, 500],
    );
  });

  it("fires alert webhook when SLO is breached and webhook URL is set", async () => {
    const sloRow = {
      id: "slo-3",
      agent_id: "agent-3",
      metric: "error_rate_pct",
      threshold: 5,
      window_minutes: 15,
      alert_webhook_url: "https://alerts.example.com/notify",
    };

    mockPool.query
      .mockResolvedValueOnce({ rows: [sloRow] })
      .mockResolvedValueOnce({ rows: [{ error_rate: 12 }] }) // 12% > 5% threshold
      .mockResolvedValueOnce({ rows: [] }); // violation INSERT

    await checkSlos("ws-3");
    // fetch is fire-and-forget, allow microtasks to flush
    await new Promise((r) => setImmediate(r));

    expect(mockFetch).toHaveBeenCalledWith(
      "https://alerts.example.com/notify",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("slo-3"),
      }),
    );
  });

  it("does not fire webhook when SSRF guard blocks the alert URL", async () => {
    mockIsBlockedUrl.mockResolvedValue(true); // block the alert URL

    const sloRow = {
      id: "slo-4",
      agent_id: "agent-4",
      metric: "error_rate_pct",
      threshold: 1,
      window_minutes: 5,
      alert_webhook_url: "http://192.168.1.1/alert",
    };

    mockPool.query
      .mockResolvedValueOnce({ rows: [sloRow] })
      .mockResolvedValueOnce({ rows: [{ error_rate: 50 }] })
      .mockResolvedValueOnce({ rows: [] });

    await checkSlos("ws-4");
    await new Promise((r) => setImmediate(r));

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("checkAllWorkspaceSlos", () => {
  it("runs checkSlos for each distinct workspace found in slo_definitions", async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{ workspace_id: "ws-a" }, { workspace_id: "ws-b" }],
      }) // distinct workspaces
      .mockResolvedValue({ rows: [] }); // all subsequent calls (individual checkSlos)

    await checkAllWorkspaceSlos();

    // First call: distinct workspace_id query
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("DISTINCT workspace_id"),
    );
    // Should have triggered SLO loads for both workspaces
    const sloCalls = mockPool.query.mock.calls.filter(
      ([sql]: [string]) => sql?.includes("slo_definitions") && sql?.includes("$1"),
    );
    expect(sloCalls.length).toBe(2);
  });
});
