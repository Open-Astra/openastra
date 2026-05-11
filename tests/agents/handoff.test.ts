import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Tests for src/agents/handoff.ts and src/agents/delegation.ts ────

// vi.hoisted so mock objects are available in vi.mock factory closures
const { mockPool } = vi.hoisted(() => {
  const pool = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    connect: vi.fn().mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }),
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
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  }),
}));

// ── Imports (after all vi.mock calls) ───────────────────────────────

import { detectHandoffSignal } from "../../src/agents/handoff.js";
import { delegateTask } from "../../src/agents/delegation.js";

// ── detectHandoffSignal tests ────────────────────────────────────────

describe("detectHandoffSignal", () => {
  it("detects [HANDOFF: agent-id] pattern in response", () => {
    const signal = detectHandoffSignal(
      "I need to hand this off. [HANDOFF: billing-agent] Please continue.",
    );
    expect(signal).not.toBeNull();
    expect(signal!.targetAgentId).toBe("billing-agent");
  });

  it("returns null when no handoff pattern is present", () => {
    const signal = detectHandoffSignal(
      "Here is the answer to your question. No handoff needed.",
    );
    expect(signal).toBeNull();
  });

  it("strips the [HANDOFF: ...] tag from the summary", () => {
    const signal = detectHandoffSignal(
      "Context summary here. [HANDOFF: support-agent] More text.",
    );
    expect(signal).not.toBeNull();
    expect(signal!.summary).not.toContain("[HANDOFF:");
    expect(signal!.summary).toContain("Context summary here");
  });

  it("trims whitespace from the target agent ID", () => {
    const signal = detectHandoffSignal("[HANDOFF:   analytics-agent   ]");
    expect(signal).not.toBeNull();
    expect(signal!.targetAgentId).toBe("analytics-agent");
  });

  it("ignores malformed patterns that don't match the regex", () => {
    // Missing closing bracket — should not match
    const signal = detectHandoffSignal("HANDOFF: billing-agent");
    expect(signal).toBeNull();
  });

  it("caps summary at 500 chars", () => {
    const longText = "A".repeat(600);
    const signal = detectHandoffSignal(`${longText} [HANDOFF: agent-x]`);
    expect(signal).not.toBeNull();
    expect(signal!.summary.length).toBeLessThanOrEqual(500);
  });
});

// ── delegateTask tests ───────────────────────────────────────────────

describe("delegateTask", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // enqueueJob reads from DB — mock the INSERT RETURNING query
    mockPool.query.mockResolvedValue({
      rows: [
        {
          id: "job-abc-123",
          workspace_id: "ws-1",
          type: "agent_run",
          status: "pending",
          payload: {},
          result: null,
          error: null,
          progress: 0,
          created_at: new Date(),
          started_at: null,
          completed_at: null,
          worker_id: null,
          max_retries: 2,
          retry_count: 0,
          timeout_seconds: 300,
        },
      ],
    });
  });

  it("returns a taskId and estimatedCompletionMs on successful delegation", async () => {
    const result = await delegateTask(
      "Summarize this document",
      "summarizer-agent",
      "ws-1",
      "user-1",
    );

    expect(result.taskId).toBe("job-abc-123");
    expect(result.estimatedCompletionMs).toBe(5 * 60 * 1000);
  });

  it("passes callbackUrl and delegatedBy options to the job payload", async () => {
    await delegateTask(
      "Process payment",
      "billing-agent",
      "ws-1",
      "user-2",
      { callbackUrl: "https://example.com/cb", delegatedBy: "root-agent" },
    );

    const queryCall = mockPool.query.mock.calls[0];
    const payloadArg = queryCall[1][2]; // JSON-stringified payload
    const parsed = JSON.parse(payloadArg as string);

    expect(parsed.callbackUrl).toBe("https://example.com/cb");
    expect(parsed.delegatedBy).toBe("root-agent");
    expect(parsed.agentId).toBe("billing-agent");
  });
});
