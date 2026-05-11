import { vi, describe, it, expect, beforeEach } from "vitest";

// Mock loadEnv so we control rpm + burst without needing real env vars
vi.mock("../../../src/config/env.js", () => ({
  loadEnv: vi.fn().mockReturnValue({
    userRateLimitRpm: 5,
    userRateLimitBurst: 0,
  }),
}));

vi.mock("../../../src/utils/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { userRateLimit } from "../../../src/gateway/middleware/user-rate-limit.js";
import { loadEnv } from "../../../src/config/env.js";
import {
  createMockRequest,
  createMockResponse,
  createMockNext,
} from "../../helpers/mock-express.js";

// The windowStore is module-level, so we need to simulate a fresh state by using
// unique UIDs per test to avoid cross-test contamination.

let uidCounter = 0;
function freshUid() {
  return `test-user-${++uidCounter}-${Date.now()}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Restore default env mock
  vi.mocked(loadEnv).mockReturnValue({
    userRateLimitRpm: 5,
    userRateLimitBurst: 0,
  } as any);
});

describe("userRateLimit middleware", () => {
  it("first request within limit passes and sets X-RateLimit-* headers", () => {
    const uid = freshUid();
    const req = createMockRequest({ uid });
    const res = createMockResponse();
    const next = createMockNext();

    userRateLimit()(req as any, res as any, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.setHeader).toHaveBeenCalledWith("X-RateLimit-Limit", 5);
    expect(res.setHeader).toHaveBeenCalledWith("X-RateLimit-Remaining", 4);
    expect(res.setHeader).toHaveBeenCalledWith(
      "X-RateLimit-Reset",
      expect.any(Number),
    );
    expect(res.status).not.toHaveBeenCalled();
  });

  it("requests up to the limit all pass", () => {
    const uid = freshUid();
    const middleware = userRateLimit();

    for (let i = 0; i < 5; i++) {
      const req = createMockRequest({ uid });
      const res = createMockResponse();
      const next = createMockNext();
      middleware(req as any, res as any, next);
      expect(next).toHaveBeenCalledOnce();
    }
  });

  it("request exceeding limit returns 429", () => {
    const uid = freshUid();
    const middleware = userRateLimit();

    // Exhaust the limit (rpm=5, burst=0)
    for (let i = 0; i < 5; i++) {
      const req = createMockRequest({ uid });
      const res = createMockResponse();
      const next = createMockNext();
      middleware(req as any, res as any, next);
    }

    // 6th request — should be rate-limited
    const req = createMockRequest({ uid });
    const res = createMockResponse();
    const next = createMockNext();
    middleware(req as any, res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "rate_limit_exceeded",
        limit: 5,
        remaining: 0,
      }),
    );
  });

  it("different UIDs are tracked independently", () => {
    const uid1 = freshUid();
    const uid2 = freshUid();
    const middleware = userRateLimit();

    // Exhaust uid1
    for (let i = 0; i < 5; i++) {
      middleware(
        createMockRequest({ uid: uid1 }) as any,
        createMockResponse() as any,
        createMockNext(),
      );
    }

    // uid2's first request should still pass
    const req = createMockRequest({ uid: uid2 });
    const res = createMockResponse();
    const next = createMockNext();
    middleware(req as any, res as any, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("window resets after WINDOW_MS elapses (mock Date.now)", () => {
    const uid = freshUid();
    const middleware = userRateLimit();
    const startTime = Date.now();

    // Exhaust limit at time T
    vi.spyOn(Date, "now").mockReturnValue(startTime);
    for (let i = 0; i < 5; i++) {
      middleware(
        createMockRequest({ uid }) as any,
        createMockResponse() as any,
        createMockNext(),
      );
    }

    // Advance 61 seconds — window has passed
    vi.spyOn(Date, "now").mockReturnValue(startTime + 61_000);

    const req = createMockRequest({ uid });
    const res = createMockResponse();
    const next = createMockNext();
    middleware(req as any, res as any, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("burst allowance lets extra requests through", () => {
    vi.mocked(loadEnv).mockReturnValue({
      userRateLimitRpm: 5,
      userRateLimitBurst: 2,
    } as any);

    const uid = freshUid();
    const middleware = userRateLimit();

    // rpm(5) + burst(2) = 7 allowed total; 7th should pass, 8th should fail
    for (let i = 0; i < 7; i++) {
      const req = createMockRequest({ uid });
      const res = createMockResponse();
      const next = createMockNext();
      middleware(req as any, res as any, next);
      expect(next).toHaveBeenCalledOnce();
    }

    // 8th request — exceeds rpm + burst
    const req = createMockRequest({ uid });
    const res = createMockResponse();
    const next = createMockNext();
    middleware(req as any, res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it("missing uid passes through without rate-limiting", () => {
    const req = createMockRequest(); // no uid
    const res = createMockResponse();
    const next = createMockNext();

    userRateLimit()(req as any, res as any, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("remaining header decrements with each request", () => {
    const uid = freshUid();
    const middleware = userRateLimit();

    const firstReq = createMockRequest({ uid });
    const firstRes = createMockResponse();
    middleware(firstReq as any, firstRes as any, createMockNext());
    // First request: 5 - 1 = 4 remaining
    expect(firstRes.setHeader).toHaveBeenCalledWith("X-RateLimit-Remaining", 4);

    const secondReq = createMockRequest({ uid });
    const secondRes = createMockResponse();
    middleware(secondReq as any, secondRes as any, createMockNext());
    // Second request: 5 - 2 = 3 remaining
    expect(secondRes.setHeader).toHaveBeenCalledWith("X-RateLimit-Remaining", 3);
  });
});
