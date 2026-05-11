import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the event bus before importing the module under test
const mockEmit = vi.fn();
vi.mock("../../src/events/index.js", () => ({
  getEventBus: () => ({ emit: mockEmit }),
}));

// Mock the logger to suppress output during tests
vi.mock("../../src/utils/logger.js", () => ({
  createLogger: () => ({
    active: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  recordThreat,
  initIntrusionDetection,
  stopIntrusionDetection,
  getThreatSummary,
} from "../../src/security/intrusion-detection.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeThreat(
  overrides: Partial<{
    category: string;
    sourceIp: string;
    uid: string;
    detail: string;
    timestamp: number;
  }> = {},
) {
  return {
    category: (overrides.category ?? "ssrf") as Parameters<typeof recordThreat>[0]["category"],
    sourceIp: overrides.sourceIp ?? "10.0.0.1",
    uid: overrides.uid,
    detail: overrides.detail ?? "test threat",
    timestamp: overrides.timestamp ?? Date.now(),
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("intrusion-detection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Reset module state between tests
    stopIntrusionDetection();
    mockEmit.mockClear();
  });

  afterEach(() => {
    stopIntrusionDetection();
    vi.useRealTimers();
  });

  // ── 1. Counter increments per category+IP ──────────────────────────

  it("increments threat counter for each recorded threat", () => {
    const now = Date.now();

    recordThreat(makeThreat({ sourceIp: "1.2.3.4", category: "ssrf", timestamp: now }));
    recordThreat(makeThreat({ sourceIp: "1.2.3.4", category: "ssrf", timestamp: now + 1 }));
    recordThreat(makeThreat({ sourceIp: "1.2.3.4", category: "ssrf", timestamp: now + 2 }));

    const summary = getThreatSummary();
    expect(summary["ssrf:1.2.3.4"]).toBeDefined();
    expect(summary["ssrf:1.2.3.4"].count).toBe(3);
    expect(summary["ssrf:1.2.3.4"].escalated).toBe(false); // threshold is 5
  });

  // ── 2. Threshold breach triggers escalation with exact thresholds ──

  describe("threshold breach triggers escalation", () => {
    const cases: Array<{ category: Parameters<typeof recordThreat>[0]["category"]; threshold: number }> = [
      { category: "ssrf", threshold: 5 },
      { category: "sqli", threshold: 3 },
      { category: "path_traversal", threshold: 5 },
      { category: "auth_failure", threshold: 10 },
      { category: "rate_limit", threshold: 20 },
      { category: "sandbox_escape", threshold: 1 },
      { category: "pii_exfil", threshold: 3 },
    ];

    for (const { category, threshold } of cases) {
      it(`escalates ${category} at threshold=${threshold}`, () => {
        const now = Date.now();

        // Record exactly threshold-1 events: no escalation yet
        for (let i = 0; i < threshold - 1; i++) {
          recordThreat(makeThreat({ category, sourceIp: "5.5.5.5", timestamp: now + i }));
        }

        expect(mockEmit).not.toHaveBeenCalled();

        // The threshold-th event triggers escalation
        recordThreat(makeThreat({ category, sourceIp: "5.5.5.5", timestamp: now + threshold }));

        expect(mockEmit).toHaveBeenCalledTimes(1);
        expect(mockEmit).toHaveBeenCalledWith(
          "security.intrusion_detected",
          expect.objectContaining({
            category,
            sourceIp: "5.5.5.5",
            count: threshold,
          }),
        );

        const summary = getThreatSummary();
        expect(summary[`${category}:5.5.5.5`].escalated).toBe(true);
      });
    }
  });

  // ── 3. Sliding window expiry resets counters ───────────────────────

  it("resets counter when event arrives outside the 10-minute window", () => {
    const WINDOW_MS = 10 * 60 * 1000;
    const now = Date.now();

    // Record 4 ssrf threats (one below threshold of 5)
    for (let i = 0; i < 4; i++) {
      recordThreat(makeThreat({ category: "ssrf", sourceIp: "7.7.7.7", timestamp: now + i }));
    }

    expect(getThreatSummary()["ssrf:7.7.7.7"].count).toBe(4);

    // Advance time beyond the window
    vi.advanceTimersByTime(WINDOW_MS + 1);

    // Next threat should start a fresh window with count=1
    recordThreat(makeThreat({
      category: "ssrf",
      sourceIp: "7.7.7.7",
      timestamp: now + WINDOW_MS + 1,
    }));

    const summary = getThreatSummary();
    expect(summary["ssrf:7.7.7.7"].count).toBe(1);
    expect(summary["ssrf:7.7.7.7"].escalated).toBe(false);
    // No escalation should have fired
    expect(mockEmit).not.toHaveBeenCalled();
  });

  // ── 4. Different source IPs are independent ────────────────────────

  it("tracks threat counters independently per source IP", () => {
    const now = Date.now();

    // IP A: 4 sqli attempts (just below threshold of 3 — wait, sqli threshold is 3)
    // Let's do 2 for IP A (below threshold) and 3 for IP B (at threshold)
    recordThreat(makeThreat({ category: "sqli", sourceIp: "10.0.0.1", timestamp: now }));
    recordThreat(makeThreat({ category: "sqli", sourceIp: "10.0.0.1", timestamp: now + 1 }));

    recordThreat(makeThreat({ category: "sqli", sourceIp: "10.0.0.2", timestamp: now }));
    recordThreat(makeThreat({ category: "sqli", sourceIp: "10.0.0.2", timestamp: now + 1 }));
    recordThreat(makeThreat({ category: "sqli", sourceIp: "10.0.0.2", timestamp: now + 2 }));

    const summary = getThreatSummary();

    // IP A: 2 threats, not escalated
    expect(summary["sqli:10.0.0.1"].count).toBe(2);
    expect(summary["sqli:10.0.0.1"].escalated).toBe(false);

    // IP B: 3 threats, escalated (sqli threshold = 3)
    expect(summary["sqli:10.0.0.2"].count).toBe(3);
    expect(summary["sqli:10.0.0.2"].escalated).toBe(true);

    // Only one escalation event (for IP B)
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledWith(
      "security.intrusion_detected",
      expect.objectContaining({ sourceIp: "10.0.0.2" }),
    );
  });

  // ── 5. Escalation fires only once per window ──────────────────────

  it("does not escalate more than once within the same window", () => {
    const now = Date.now();

    // sandbox_escape has threshold=1, so the first event escalates
    recordThreat(makeThreat({ category: "sandbox_escape", sourceIp: "9.9.9.9", timestamp: now }));
    expect(mockEmit).toHaveBeenCalledTimes(1);

    // Additional events in the same window should NOT trigger another escalation
    recordThreat(makeThreat({ category: "sandbox_escape", sourceIp: "9.9.9.9", timestamp: now + 1000 }));
    recordThreat(makeThreat({ category: "sandbox_escape", sourceIp: "9.9.9.9", timestamp: now + 2000 }));
    recordThreat(makeThreat({ category: "sandbox_escape", sourceIp: "9.9.9.9", timestamp: now + 3000 }));

    // Still only one escalation
    expect(mockEmit).toHaveBeenCalledTimes(1);

    // Counter continues incrementing though
    const summary = getThreatSummary();
    expect(summary["sandbox_escape:9.9.9.9"].count).toBe(4);
    expect(summary["sandbox_escape:9.9.9.9"].escalated).toBe(true);
  });

  // ── 6. recordThreat creates new entry for unknown key ──────────────

  it("creates a new counter entry for a previously unseen category+IP", () => {
    expect(getThreatSummary()).toEqual({});

    recordThreat(makeThreat({ category: "path_traversal", sourceIp: "192.168.1.1" }));

    const summary = getThreatSummary();
    expect(Object.keys(summary)).toHaveLength(1);
    expect(summary["path_traversal:192.168.1.1"]).toEqual({
      count: 1,
      escalated: false,
    });
  });

  // ── 7. Escalation event carries correct severity ──────────────────

  it("emits event with correct severity per category", () => {
    const now = Date.now();

    // Trigger sqli escalation (threshold=3, severity=critical)
    for (let i = 0; i < 3; i++) {
      recordThreat(makeThreat({ category: "sqli", sourceIp: "8.8.8.8", timestamp: now + i }));
    }

    expect(mockEmit).toHaveBeenCalledWith(
      "security.intrusion_detected",
      expect.objectContaining({
        severity: "critical",
        category: "sqli",
        windowMs: 10 * 60 * 1000,
      }),
    );
  });

  // ── 8. stopIntrusionDetection clears all state ────────────────────

  it("clears all counters when stopIntrusionDetection is called", () => {
    recordThreat(makeThreat({ category: "ssrf", sourceIp: "1.1.1.1" }));
    recordThreat(makeThreat({ category: "sqli", sourceIp: "2.2.2.2" }));

    expect(Object.keys(getThreatSummary())).toHaveLength(2);

    stopIntrusionDetection();

    expect(getThreatSummary()).toEqual({});
  });

  // ── 9. Window expiry allows fresh escalation in new window ────────

  it("allows escalation again after the window expires and new threats arrive", () => {
    const WINDOW_MS = 10 * 60 * 1000;
    const now = Date.now();

    // First window: trigger sandbox_escape escalation (threshold=1)
    recordThreat(makeThreat({ category: "sandbox_escape", sourceIp: "3.3.3.3", timestamp: now }));
    expect(mockEmit).toHaveBeenCalledTimes(1);

    // Advance past window
    vi.advanceTimersByTime(WINDOW_MS + 1);

    // Second window: new threat should start fresh and escalate again
    recordThreat(makeThreat({
      category: "sandbox_escape",
      sourceIp: "3.3.3.3",
      timestamp: now + WINDOW_MS + 1,
    }));

    expect(mockEmit).toHaveBeenCalledTimes(2);

    // The counter should be fresh (count=1)
    const summary = getThreatSummary();
    expect(summary["sandbox_escape:3.3.3.3"].count).toBe(1);
    expect(summary["sandbox_escape:3.3.3.3"].escalated).toBe(true);
  });

  // ── 10. initIntrusionDetection starts cleanup interval ─────────────

  it("cleanup interval removes stale counters after window expires", () => {
    const WINDOW_MS = 10 * 60 * 1000;
    const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

    initIntrusionDetection();

    // Record a threat
    recordThreat(makeThreat({ category: "auth_failure", sourceIp: "4.4.4.4" }));
    expect(Object.keys(getThreatSummary())).toHaveLength(1);

    // Advance past the window + one cleanup interval so cleanup() runs
    // and finds the counter stale (lastSeen > WINDOW_MS ago)
    vi.advanceTimersByTime(WINDOW_MS + CLEANUP_INTERVAL_MS + 1);

    // The cleanup interval should have removed the stale counter
    expect(getThreatSummary()).toEqual({});
  });
});
