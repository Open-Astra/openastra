import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockPool } from "../helpers/mock-pool.js";

// ── Mock getPool so revocation queries hit an in-memory fake ────────
const mockPool = createMockPool();

vi.mock("../../src/config/postgres.js", () => ({
  getPool: () => mockPool,
}));

// Suppress logger output during tests
vi.mock("../../src/utils/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    dim: vi.fn(),
    active: vi.fn(),
    warn: vi.fn(),
  }),
}));

import {
  initJwt,
  signAccessToken,
  verifyAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  computeFingerprint,
  hashRefreshToken,
  isTokenRevoked,
  decodeTokenUnsafe,
  revokeAllAccessTokens,
} from "../../src/auth/jwt.js";
import * as jose from "jose";

// ── Helpers ─────────────────────────────────────────────────────────

const TEST_SECRET = "test-secret-that-is-long-enough-for-hs256";
const TEST_SECRET_PREV = "previous-secret-for-rotation-testing-ok";

function defaultInit(overrides: Record<string, unknown> = {}) {
  initJwt({
    jwtSecret: TEST_SECRET,
    accessExpires: "15m",
    refreshExpires: "7d",
    ...overrides,
  });
}

// ────────────────────────────────────────────────────────────────────

describe("JWT Auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset pool to return no revoked tokens by default
    mockPool.query.mockImplementation(async () => ({ rows: [] }));
    defaultInit();
  });

  // ── Sign / Verify roundtrip ──────────────────────────────────────

  describe("sign/verify roundtrip", () => {
    it("signAccessToken then verifyAccessToken returns the uid", async () => {
      const token = await signAccessToken("user-123");
      const result = await verifyAccessToken(token);
      expect(result.uid).toBe("user-123");
    });

    it("signRefreshToken then verifyRefreshToken returns the uid", async () => {
      const token = await signRefreshToken("user-456");
      const result = await verifyRefreshToken(token);
      expect(result.uid).toBe("user-456");
    });

    it("access token contains a jti claim", async () => {
      const token = await signAccessToken("user-abc");
      const claims = decodeTokenUnsafe(token);
      expect(claims.jti).toBeDefined();
      expect(typeof claims.jti).toBe("string");
      expect(claims.jti!.length).toBeGreaterThan(0);
    });
  });

  // ── Expired tokens ───────────────────────────────────────────────

  describe("expired tokens", () => {
    it("rejects an expired access token", async () => {
      initJwt({ jwtSecret: TEST_SECRET, accessExpires: "1s" });
      const token = await signAccessToken("user-exp");

      // Wait for the token to expire
      await new Promise((r) => setTimeout(r, 1500));

      await expect(verifyAccessToken(token)).rejects.toThrow();
    });

    it("rejects an expired refresh token", async () => {
      initJwt({ jwtSecret: TEST_SECRET, refreshExpires: "1s" });
      const token = await signRefreshToken("user-exp2");

      await new Promise((r) => setTimeout(r, 1500));

      await expect(verifyRefreshToken(token)).rejects.toThrow();
    });
  });

  // ── Tampered tokens ──────────────────────────────────────────────

  describe("tampered tokens", () => {
    it("rejects a token with a modified payload", async () => {
      const token = await signAccessToken("user-legit");

      // Tamper: split the JWT and alter the payload segment
      const parts = token.split(".");
      const payloadJson = Buffer.from(parts[1]!, "base64url").toString();
      const payload = JSON.parse(payloadJson);
      payload.uid = "user-evil";
      parts[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const tampered = parts.join(".");

      await expect(verifyAccessToken(tampered)).rejects.toThrow();
    });

    it("rejects a token signed with a wrong secret", async () => {
      // Sign with a completely different secret
      const wrongSecret = new TextEncoder().encode("wrong-secret-entirely-different");
      const token = await new jose.SignJWT({ uid: "user-wrong" })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("15m")
        .setSubject("user-wrong")
        .sign(wrongSecret);

      await expect(verifyAccessToken(token)).rejects.toThrow();
    });

    it("rejects a completely garbage string", async () => {
      await expect(verifyAccessToken("not-a-jwt-at-all")).rejects.toThrow();
    });
  });

  // ── Token type confusion ─────────────────────────────────────────

  describe("token type confusion", () => {
    it("rejects a refresh token used as an access token", async () => {
      const refreshToken = await signRefreshToken("user-type");
      await expect(verifyAccessToken(refreshToken)).rejects.toThrow(
        "Refresh token cannot be used as access token",
      );
    });

    it("rejects an access token used as a refresh token", async () => {
      const accessToken = await signAccessToken("user-type");
      await expect(verifyRefreshToken(accessToken)).rejects.toThrow(
        "Not a refresh token",
      );
    });
  });

  // ── Device fingerprint binding ───────────────────────────────────

  describe("device fingerprint binding", () => {
    const fp = computeFingerprint("Mozilla/5.0 TestBrowser", "192.168.1");

    beforeEach(() => {
      initJwt({ jwtSecret: TEST_SECRET, bindToDevice: true });
    });

    it("computeFingerprint returns a 16-char hex string", () => {
      expect(fp).toMatch(/^[0-9a-f]{16}$/);
    });

    it("computeFingerprint is deterministic", () => {
      const fp2 = computeFingerprint("Mozilla/5.0 TestBrowser", "192.168.1");
      expect(fp2).toBe(fp);
    });

    it("accepts a token when the fingerprint matches", async () => {
      const token = await signAccessToken("user-dfp", fp);
      const result = await verifyAccessToken(token, fp);
      expect(result.uid).toBe("user-dfp");
    });

    it("rejects a token when the fingerprint mismatches", async () => {
      const token = await signAccessToken("user-dfp", fp);
      const wrongFp = computeFingerprint("DifferentAgent", "10.0.0");
      await expect(verifyAccessToken(token, wrongFp)).rejects.toThrow(
        "Token device fingerprint mismatch",
      );
    });

    it("does not embed dfp claim when bindToDevice is false", async () => {
      initJwt({ jwtSecret: TEST_SECRET, bindToDevice: false });
      const token = await signAccessToken("user-no-dfp", fp);
      const decoded = jose.decodeJwt(token);
      expect(decoded.dfp).toBeUndefined();
    });
  });

  // ── Dual-key rotation ────────────────────────────────────────────

  describe("dual-key rotation", () => {
    it("verifies an old access token with the previous secret after rotation", async () => {
      // Step 1: sign a token with the original secret
      initJwt({ jwtSecret: TEST_SECRET });
      const oldToken = await signAccessToken("user-rotate");

      // Step 2: rotate — the old secret becomes prevSecret
      initJwt({ jwtSecret: "brand-new-secret-after-rotation", jwtSecretPrev: TEST_SECRET });

      // The old token should still verify via prevSecret
      const result = await verifyAccessToken(oldToken);
      expect(result.uid).toBe("user-rotate");
    });

    it("verifies an old refresh token with the previous secret after rotation", async () => {
      initJwt({ jwtSecret: TEST_SECRET });
      const oldRefresh = await signRefreshToken("user-rotate-r");

      initJwt({ jwtSecret: "brand-new-secret-after-rotation", jwtSecretPrev: TEST_SECRET });

      const result = await verifyRefreshToken(oldRefresh);
      expect(result.uid).toBe("user-rotate-r");
    });

    it("rejects a token when neither current nor previous secret matches", async () => {
      initJwt({ jwtSecret: TEST_SECRET });
      const token = await signAccessToken("user-old");

      // Rotate both secrets — original is now gone
      initJwt({
        jwtSecret: "completely-new-secret-abc",
        jwtSecretPrev: "also-different-prev-secret",
      });

      await expect(verifyAccessToken(token)).rejects.toThrow();
    });
  });

  // ── isTokenRevoked ───────────────────────────────────────────────

  describe("isTokenRevoked", () => {
    it("returns false when the jti is not in revoked_tokens", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      const result = await isTokenRevoked("some-jti-not-revoked");
      expect(result).toBe(false);
    });

    it("returns true when the jti is found in revoked_tokens", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ jti: "revoked-jti" }] });
      const result = await isTokenRevoked("revoked-jti");
      expect(result).toBe(true);
    });

    it("returns true (fail-closed) on database error", async () => {
      mockPool.query.mockRejectedValueOnce(new Error("connection refused"));
      const result = await isTokenRevoked("any-jti");
      expect(result).toBe(true);
    });
  });

  // ── Sentinel revocation (all:uid) ────────────────────────────────

  describe("sentinel revocation (all:uid)", () => {
    it("rejects an access token when the all:<uid> sentinel exists", async () => {
      const token = await signAccessToken("user-sentinel");

      // First query (jti check) returns no match; second query (sentinel) returns a match
      mockPool.query
        .mockResolvedValueOnce({ rows: [] })                         // jti lookup
        .mockResolvedValueOnce({ rows: [{ jti: "all:user-sentinel" }] }); // sentinel

      await expect(verifyAccessToken(token)).rejects.toThrow(
        "All tokens for this user have been revoked",
      );
    });

    it("passes when no sentinel exists for the uid", async () => {
      const token = await signAccessToken("user-clean");

      // Both queries return empty
      mockPool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await verifyAccessToken(token);
      expect(result.uid).toBe("user-clean");
    });

    it("revokeAllAccessTokens inserts the sentinel row", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      await revokeAllAccessTokens("user-revoke-all");

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO revoked_tokens"),
        expect.arrayContaining(["all:user-revoke-all"]),
      );
    });
  });

  // ── Utility functions ────────────────────────────────────────────

  describe("utility functions", () => {
    it("hashRefreshToken returns a hex SHA-256 hash", () => {
      const hash = hashRefreshToken("some-token-value");
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("hashRefreshToken is deterministic", () => {
      const h1 = hashRefreshToken("token-abc");
      const h2 = hashRefreshToken("token-abc");
      expect(h1).toBe(h2);
    });

    it("decodeTokenUnsafe extracts claims from a valid token", async () => {
      const token = await signAccessToken("user-decode");
      const claims = decodeTokenUnsafe(token);
      expect(claims.sub).toBe("user-decode");
      expect(claims.jti).toBeDefined();
      expect(claims.exp).toBeDefined();
    });

    it("decodeTokenUnsafe returns empty object for garbage input", () => {
      const claims = decodeTokenUnsafe("not.a.jwt");
      expect(claims).toEqual({});
    });
  });
});
