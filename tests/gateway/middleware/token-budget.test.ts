import { vi, describe, it, expect, beforeEach } from "vitest";

// checkTokenBudget mock — needs to be hoisted so the factory closure captures it
const { mockCheckTokenBudget } = vi.hoisted(() => {
  return { mockCheckTokenBudget: vi.fn() };
});

vi.mock("../../../src/billing/budget-check.js", () => ({
  checkTokenBudget: mockCheckTokenBudget,
}));

import { tokenBudget } from "../../../src/gateway/middleware/token-budget.js";
import {
  createMockRequest,
  createMockResponse,
  createMockNext,
} from "../../helpers/mock-express.js";

// Shorthand for a budget result
function allowedResult(overrides = {}) {
  return {
    allowed: true,
    degraded: false,
    currentUsage: 1000,
    limit: 100_000,
    tier: "free" as const,
    ...overrides,
  };
}

function blockedResult(overrides = {}) {
  return {
    allowed: false,
    degraded: false,
    currentUsage: 100_000,
    limit: 100_000,
    tier: "free" as const,
    reason: "Monthly token limit reached",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("tokenBudget middleware", () => {
  it("request within budget passes through", async () => {
    mockCheckTokenBudget.mockResolvedValue(allowedResult());

    const req = createMockRequest({ uid: "user-1" });
    const res = createMockResponse();
    const next = createMockNext();

    await tokenBudget()(req as any, res as any, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("request exceeding hard cap returns 429 with usage info", async () => {
    mockCheckTokenBudget.mockResolvedValue(blockedResult());

    const req = createMockRequest({ uid: "user-1" });
    const res = createMockResponse();
    const next = createMockNext();

    await tokenBudget()(req as any, res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Token budget exceeded",
        usage: expect.objectContaining({
          current: 100_000,
          limit: 100_000,
        }),
        upgradeUrl: "/billing/upgrade",
      }),
    );
  });

  it("soft cap degraded → sets budgetDegraded + overrideModel on request", async () => {
    mockCheckTokenBudget.mockResolvedValue(
      allowedResult({ degraded: true, overrideModel: "gpt-3.5-turbo" }),
    );

    const req = createMockRequest({ uid: "user-1" }) as any;
    const res = createMockResponse();
    const next = createMockNext();

    await tokenBudget()(req, res as any, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.budgetDegraded).toBe(true);
    expect(req.overrideModel).toBe("gpt-3.5-turbo");
  });

  it("missing uid (unauthenticated) passes through without calling budget check", async () => {
    const req = createMockRequest(); // no uid
    const res = createMockResponse();
    const next = createMockNext();

    await tokenBudget()(req as any, res as any, next);

    expect(next).toHaveBeenCalledOnce();
    expect(mockCheckTokenBudget).not.toHaveBeenCalled();
  });

  it("budget check throws → passes through (fail-open)", async () => {
    mockCheckTokenBudget.mockRejectedValue(new Error("DB unavailable"));

    const req = createMockRequest({ uid: "user-1" });
    const res = createMockResponse();
    const next = createMockNext();

    await tokenBudget()(req as any, res as any, next);

    // Should not block — budget check errors are non-fatal
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("allowed result with no degraded flag does not set budgetDegraded", async () => {
    mockCheckTokenBudget.mockResolvedValue(allowedResult());

    const req = createMockRequest({ uid: "user-1" }) as any;
    const res = createMockResponse();
    const next = createMockNext();

    await tokenBudget()(req, res as any, next);

    expect(req.budgetDegraded).toBeUndefined();
    expect(req.overrideModel).toBeUndefined();
  });
});
