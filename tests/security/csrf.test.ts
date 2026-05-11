import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { csrfProtection } from "../../src/gateway/middleware/csrf.js";
import {
  createMockRequest,
  createMockResponse,
  createMockNext,
} from "../helpers/mock-express.js";

describe("csrfProtection middleware", () => {
  let mw: (req: Request, res: Response, next: NextFunction) => void;

  beforeEach(() => {
    mw = csrfProtection();
  });

  function run(reqOverrides: Record<string, unknown> = {}) {
    const req = createMockRequest(reqOverrides);
    const res = createMockResponse();
    const next = createMockNext();
    mw(req as unknown as Request, res as unknown as Response, next as NextFunction);
    return { req, res, next };
  }

  // ── Safe methods skip validation ────────────────────────────────────

  it("allows GET requests through without CSRF validation", () => {
    const { next, res } = run({ method: "GET" });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("allows HEAD requests through without CSRF validation", () => {
    const { next, res } = run({ method: "HEAD" });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("allows OPTIONS requests through without CSRF validation", () => {
    const { next, res } = run({ method: "OPTIONS" });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  // ── Cookie generation ───────────────────────────────────────────────

  it("sets a csrf_token cookie when none exists on the request", () => {
    const { res } = run({ method: "GET", cookies: {} });
    expect(res.cookie).toHaveBeenCalledTimes(1);
    const [name, value, options] = (res.cookie as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(name).toBe("csrf_token");
    // 32 bytes = 64 hex chars
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(options.httpOnly).toBe(false);
    expect(options.sameSite).toBe("strict");
    expect(options.path).toBe("/");
  });

  it("does not regenerate the cookie when csrf_token cookie already exists", () => {
    const token = crypto.randomBytes(32).toString("hex");
    const { res } = run({ method: "GET", cookies: { csrf_token: token } });
    expect(res.cookie).not.toHaveBeenCalled();
  });

  // ── Bearer token exemption ──────────────────────────────────────────

  it("skips CSRF validation when Authorization: Bearer header is present", () => {
    const { next, res } = run({
      method: "POST",
      headers: { authorization: "Bearer some-jwt-token" },
      cookies: {},
    });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  // ── Rejection cases ─────────────────────────────────────────────────

  it("rejects POST with no cookie and no header (403)", () => {
    const { next, res } = run({
      method: "POST",
      cookies: {},
      headers: {},
    });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "CSRF token validation failed" }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects POST when cookie and header tokens do not match", () => {
    const cookieToken = crypto.randomBytes(32).toString("hex");
    const wrongHeader = crypto.randomBytes(32).toString("hex");
    const { next, res } = run({
      method: "POST",
      cookies: { csrf_token: cookieToken },
      headers: { "x-csrf-token": wrongHeader },
    });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "CSRF token validation failed" }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects POST when cookie is present but header is missing", () => {
    const cookieToken = crypto.randomBytes(32).toString("hex");
    const { next, res } = run({
      method: "POST",
      cookies: { csrf_token: cookieToken },
      headers: {},
    });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  // ── Success case ────────────────────────────────────────────────────

  it("allows POST when cookie and x-csrf-token header match", () => {
    const token = crypto.randomBytes(32).toString("hex");
    const { next, res } = run({
      method: "POST",
      cookies: { csrf_token: token },
      headers: { "x-csrf-token": token },
    });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
