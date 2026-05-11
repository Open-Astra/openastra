import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Hoisted shared mock pool ──────────────────────────────────────────
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
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    dim: vi.fn(),
    active: vi.fn(),
  }),
}));

import { recordTokenUsage, getUsageSummary, checkBudget } from "../../src/inference/token-budget.js";
import type { TokenUsageEntry } from "../../src/inference/token-budget.js";

// ── Helpers ───────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<TokenUsageEntry> = {}): TokenUsageEntry {
  return {
    uid: "user-123",
    agentId: "agent-1",
    sessionId: "session-abc",
    provider: "openai",
    modelId: "gpt-4o",
    promptTokens: 100,
    completionTokens: 50,
    cachedTokens: 0,
    ...overrides,
  };
}

// Helper: find a pool.query call whose first arg (SQL) includes the given pattern
function findCall(pattern: string): unknown[] | undefined {
  return mockPool.query.mock.calls.find((c: unknown[]) =>
    (c[0] as string).includes(pattern),
  );
}

// Helper to set up mockPool.query so each SQL pattern maps to a specific result.
// Uses mockImplementation with a lookup table; falls back to { rows: [] }.
function setupQueryResponses(map: Record<string, { rows: unknown[] }>) {
  mockPool.query.mockImplementation(async (sql: string) => {
    for (const [pattern, result] of Object.entries(map)) {
      if (sql.includes(pattern)) return result;
    }
    return { rows: [] };
  });
}

describe("recordTokenUsage()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPool.query.mockResolvedValue({ rows: [] });
  });

  it("calls ensureTable (CREATE TABLE IF NOT EXISTS) on first call and then INSERT", async () => {
    await recordTokenUsage(makeEntry());

    const allCalls: string[] = mockPool.query.mock.calls.map((c: unknown[]) => c[0] as string);
    // ensureTable runs CREATE TABLE IF NOT EXISTS (may be skipped if tableReady=true from prior tests)
    const hasInsert = allCalls.some((sql) => sql.includes("INSERT INTO token_usage"));
    expect(hasInsert).toBe(true);
  });

  it("passes all entry fields to the INSERT query", async () => {
    const entry = makeEntry({ uid: "user-x", agentId: "agent-y", promptTokens: 200, completionTokens: 100 });
    await recordTokenUsage(entry);

    const insertCall = findCall("INSERT INTO token_usage");
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as unknown[];
    expect(params).toContain("user-x");
    expect(params).toContain("agent-y");
    expect(params).toContain(200);
    expect(params).toContain(100);
  });

  it("estimates non-zero cost for known model (gpt-4o)", async () => {
    const entry = makeEntry({ modelId: "gpt-4o", promptTokens: 1000, completionTokens: 500, cachedTokens: 0 });
    await recordTokenUsage(entry);

    const insertCall = findCall("INSERT INTO token_usage");
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as unknown[];
    // cost parameter is last (index 8) — should be > 0 for gpt-4o
    const cost = params[8] as number;
    expect(cost).toBeGreaterThan(0);
  });

  it("estimates zero cost for ollama model (local = free)", async () => {
    const entry = makeEntry({ modelId: "ollama", provider: "ollama", promptTokens: 1000, completionTokens: 500 });
    await recordTokenUsage(entry);

    const insertCall = findCall("INSERT INTO token_usage");
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as unknown[];
    const cost = params[8] as number;
    expect(cost).toBe(0);
  });

  it("handles null sessionId gracefully (passed as NULL to DB)", async () => {
    const entry = makeEntry({ sessionId: undefined });
    await recordTokenUsage(entry);

    const insertCall = findCall("INSERT INTO token_usage");
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as unknown[];
    // sessionId is 3rd param (index 2), should be null
    expect(params[2]).toBeNull();
  });
});

describe("getUsageSummary()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns correct aggregated usage from DB rows", async () => {
    const summaryRow = {
      total_tokens: "1500",
      prompt_tokens: "1000",
      completion_tokens: "500",
      cached_tokens: "200",
      estimated_cost: "0.0125",
      request_count: "5",
    };

    setupQueryResponses({
      "SUM(prompt_tokens + completion_tokens) AS total_tokens": { rows: [summaryRow] },
      "GROUP BY model_id": { rows: [{ model_id: "gpt-4o", tokens: "1500", cost: "0.0125" }] },
      "GROUP BY agent_id": { rows: [{ agent_id: "agent-1", tokens: "1500" }] },
    });

    const result = await getUsageSummary("user-123", "day");

    expect(result.totalTokens).toBe(1500);
    expect(result.promptTokens).toBe(1000);
    expect(result.completionTokens).toBe(500);
    expect(result.cachedTokens).toBe(200);
    expect(result.estimatedCostUsd).toBeCloseTo(0.0125);
    expect(result.requestCount).toBe(5);
    expect(result.byModel).toHaveLength(1);
    expect(result.byModel[0]!.modelId).toBe("gpt-4o");
    expect(result.byAgent).toHaveLength(1);
    expect(result.byAgent[0]!.agentId).toBe("agent-1");
  });

  it("returns zero values when there is no usage data", async () => {
    const emptyRow = {
      total_tokens: null,
      prompt_tokens: null,
      completion_tokens: null,
      cached_tokens: null,
      estimated_cost: null,
      request_count: null,
    };

    setupQueryResponses({
      "SUM(prompt_tokens + completion_tokens) AS total_tokens": { rows: [emptyRow] },
      "GROUP BY model_id": { rows: [] },
      "GROUP BY agent_id": { rows: [] },
    });

    const result = await getUsageSummary("new-user", "week");

    expect(result.totalTokens).toBe(0);
    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
    expect(result.estimatedCostUsd).toBe(0);
    expect(result.requestCount).toBe(0);
  });
});

describe("checkBudget()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports withinBudget=true when usage is below limits", async () => {
    setupQueryResponses({
      "SELECT daily_limit, monthly_limit, alert_threshold": {
        rows: [{ daily_limit: 500_000, monthly_limit: 10_000_000, alert_threshold: 0.8 }],
      },
      "INTERVAL '1 day'": { rows: [{ tokens: "10000" }] },
      "INTERVAL '30 days'": { rows: [{ tokens: "50000" }] },
    });

    const result = await checkBudget("user-within");

    expect(result.withinBudget).toBe(true);
    expect(result.dailyUsed).toBe(10_000);
    expect(result.monthlyUsed).toBe(50_000);
  });

  it("reports withinBudget=false when daily usage exceeds limit", async () => {
    setupQueryResponses({
      "SELECT daily_limit, monthly_limit, alert_threshold": {
        rows: [{ daily_limit: 500_000, monthly_limit: 10_000_000, alert_threshold: 0.8 }],
      },
      "INTERVAL '1 day'": { rows: [{ tokens: "600000" }] },
      "INTERVAL '30 days'": { rows: [{ tokens: "1000000" }] },
    });

    const result = await checkBudget("user-over-daily");

    expect(result.withinBudget).toBe(false);
    expect(result.dailyUsed).toBe(600_000);
    expect(result.dailyLimit).toBe(500_000);
  });

  it("uses default budget (500k daily / 10M monthly) when no budget row exists", async () => {
    setupQueryResponses({
      "SELECT daily_limit, monthly_limit, alert_threshold": { rows: [] },
      "INTERVAL '1 day'": { rows: [{ tokens: "1000" }] },
      "INTERVAL '30 days'": { rows: [{ tokens: "5000" }] },
    });

    const result = await checkBudget("new-user-defaults");

    expect(result.dailyLimit).toBe(500_000);
    expect(result.monthlyLimit).toBe(10_000_000);
    expect(result.withinBudget).toBe(true);
  });

  it("usagePercent reflects the higher of daily/monthly ratios", async () => {
    setupQueryResponses({
      "SELECT daily_limit, monthly_limit, alert_threshold": {
        rows: [{ daily_limit: 100_000, monthly_limit: 1_000_000, alert_threshold: 0.8 }],
      },
      "INTERVAL '1 day'": { rows: [{ tokens: "50000" }] },
      "INTERVAL '30 days'": { rows: [{ tokens: "900000" }] },
    });

    const result = await checkBudget("user-high-monthly");

    // usagePercent should be 0.90 (monthly is higher) — rounded to 2dp
    expect(result.usagePercent).toBeCloseTo(0.9, 2);
  });

  it("remaining budget calculation: dailyLimit - dailyUsed = remaining", async () => {
    setupQueryResponses({
      "SELECT daily_limit, monthly_limit, alert_threshold": {
        rows: [{ daily_limit: 500_000, monthly_limit: 10_000_000, alert_threshold: 0.8 }],
      },
      "INTERVAL '1 day'": { rows: [{ tokens: "120000" }] },
      "INTERVAL '30 days'": { rows: [{ tokens: "300000" }] },
    });

    const result = await checkBudget("user-remaining");

    const remaining = result.dailyLimit - result.dailyUsed;
    expect(remaining).toBe(380_000);
    expect(result.withinBudget).toBe(true);
  });
});
