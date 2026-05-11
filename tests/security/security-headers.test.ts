import { describe, it, expect } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { securityHeaders } from "../../src/gateway/middleware/security-headers.js";
import {
  createMockRequest,
  createMockResponse,
  createMockNext,
} from "../helpers/mock-express.js";

describe("securityHeaders middleware", () => {
  function run(
    reqOverrides: Record<string, unknown> = {},
  ): { req: ReturnType<typeof createMockRequest>; res: ReturnType<typeof createMockResponse>; next: ReturnType<typeof createMockNext> } {
    const req = createMockRequest(reqOverrides);
    const res = createMockResponse();
    const next = createMockNext();
    const mw = securityHeaders();
    mw(req as unknown as Request, res as unknown as Response, next as NextFunction);
    return { req, res, next };
  }

  // ── Individual header assertions ────────────────────────────────────

  it("sets X-Content-Type-Options to nosniff", () => {
    const { res } = run();
    expect(res.setHeader).toHaveBeenCalledWith("X-Content-Type-Options", "nosniff");
  });

  it("sets X-Frame-Options to DENY", () => {
    const { res } = run();
    expect(res.setHeader).toHaveBeenCalledWith("X-Frame-Options", "DENY");
  });

  it("sets X-XSS-Protection to 0", () => {
    const { res } = run();
    expect(res.setHeader).toHaveBeenCalledWith("X-XSS-Protection", "0");
  });

  it("sets Strict-Transport-Security with max-age and includeSubDomains", () => {
    const { res } = run();
    expect(res.setHeader).toHaveBeenCalledWith(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  });

  it("sets Referrer-Policy to strict-origin-when-cross-origin", () => {
    const { res } = run();
    expect(res.setHeader).toHaveBeenCalledWith(
      "Referrer-Policy",
      "strict-origin-when-cross-origin",
    );
  });

  it("sets Content-Security-Policy with default-src and frame-ancestors", () => {
    const { res } = run();
    expect(res.setHeader).toHaveBeenCalledWith(
      "Content-Security-Policy",
      "default-src 'self'; frame-ancestors 'none'",
    );
  });

  it("sets X-Permitted-Cross-Domain-Policies to none", () => {
    const { res } = run();
    expect(res.setHeader).toHaveBeenCalledWith("X-Permitted-Cross-Domain-Policies", "none");
  });

  it("sets X-DNS-Prefetch-Control to off", () => {
    const { res } = run();
    expect(res.setHeader).toHaveBeenCalledWith("X-DNS-Prefetch-Control", "off");
  });

  it("sets X-Download-Options to noopen", () => {
    const { res } = run();
    expect(res.setHeader).toHaveBeenCalledWith("X-Download-Options", "noopen");
  });

  it("sets Cross-Origin-Opener-Policy to same-origin", () => {
    const { res } = run();
    expect(res.setHeader).toHaveBeenCalledWith("Cross-Origin-Opener-Policy", "same-origin");
  });

  it("sets Cross-Origin-Resource-Policy to same-origin", () => {
    const { res } = run();
    expect(res.setHeader).toHaveBeenCalledWith("Cross-Origin-Resource-Policy", "same-origin");
  });

  it("sets Permissions-Policy restricting camera, microphone, geolocation, interest-cohort", () => {
    const { res } = run();
    expect(res.setHeader).toHaveBeenCalledWith(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), interest-cohort=()",
    );
  });

  // ── X-Powered-By removal ───────────────────────────────────────────

  it("removes X-Powered-By header", () => {
    const { res } = run();
    expect(res.removeHeader).toHaveBeenCalledWith("X-Powered-By");
  });

  // ── Calls next() ───────────────────────────────────────────────────

  it("calls next() to pass control to the next middleware", () => {
    const { next } = run();
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });
});
