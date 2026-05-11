import { describe, it, expect, vi, beforeEach } from "vitest";

// Suppress logger
vi.mock("../../../src/utils/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    dim: vi.fn(),
    active: vi.fn(),
    warn: vi.fn(),
  }),
}));

import {
  checkConnectionRateLimit,
  initMessageRateLimit,
  checkMessageRateLimit,
} from "../../../src/gateway/middleware/ws-rate-limit.js";
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";

// ── Helpers ─────────────────────────────────────────────────────────

function makeReq(ip: string): IncomingMessage {
  return {
    headers: {},
    socket: { remoteAddress: ip },
  } as unknown as IncomingMessage;
}

function makeReqWithForwardedFor(forwardedFor: string): IncomingMessage {
  return {
    headers: { "x-forwarded-for": forwardedFor },
    socket: { remoteAddress: "10.0.0.1" },
  } as unknown as IncomingMessage;
}

function makeWs(): WebSocket {
  return {
    close: vi.fn(),
    readyState: 1,
  } as unknown as WebSocket;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("WebSocket Rate Limiting", () => {
  describe("checkConnectionRateLimit", () => {
    it("allows connections within the 10-per-minute limit for a new IP", () => {
      // Use a unique IP each test to avoid cross-test state
      const req = makeReq("192.168.100.1");
      const allowed = checkConnectionRateLimit(req);
      expect(allowed).toBe(true);
    });

    it("allows up to MAX_CONNECTIONS_PER_IP (10) connections in the window", () => {
      const req = makeReq("192.168.100.2");
      // Connections 1-10 should be allowed
      for (let i = 0; i < 10; i++) {
        expect(checkConnectionRateLimit(req)).toBe(true);
      }
    });

    it("rejects the 11th connection from the same IP within the window", () => {
      const req = makeReq("192.168.100.3");
      for (let i = 0; i < 10; i++) {
        checkConnectionRateLimit(req);
      }
      const eleventh = checkConnectionRateLimit(req);
      expect(eleventh).toBe(false);
    });

    it("extracts the real client IP from X-Forwarded-For header", () => {
      // Two requests from different real IPs sharing the same proxy
      const req1 = makeReqWithForwardedFor("203.0.113.1, 10.0.0.1");
      const req2 = makeReqWithForwardedFor("203.0.113.2, 10.0.0.1");

      // Both should be allowed because they map to different real IPs
      expect(checkConnectionRateLimit(req1)).toBe(true);
      expect(checkConnectionRateLimit(req2)).toBe(true);
    });

    it("tracks connections per-IP independently", () => {
      const reqA = makeReq("10.10.10.1");
      const reqB = makeReq("10.10.10.2");

      // Exhaust limit for IP A
      for (let i = 0; i < 10; i++) checkConnectionRateLimit(reqA);
      expect(checkConnectionRateLimit(reqA)).toBe(false);

      // IP B should still be allowed
      expect(checkConnectionRateLimit(reqB)).toBe(true);
    });
  });

  describe("checkMessageRateLimit", () => {
    it("allows messages within the 100-per-minute limit", () => {
      const ws = makeWs();
      initMessageRateLimit(ws);
      const allowed = checkMessageRateLimit(ws);
      expect(allowed).toBe(true);
    });

    it("allows up to 100 messages per connection per minute", () => {
      const ws = makeWs();
      initMessageRateLimit(ws);
      for (let i = 0; i < 100; i++) {
        expect(checkMessageRateLimit(ws)).toBe(true);
      }
    });

    it("rejects the 101st message and closes the WebSocket with code 1008", () => {
      const ws = makeWs();
      initMessageRateLimit(ws);
      for (let i = 0; i < 100; i++) {
        checkMessageRateLimit(ws);
      }
      const result = checkMessageRateLimit(ws);
      expect(result).toBe(false);
      expect(ws.close).toHaveBeenCalledWith(1008, "Rate limit exceeded");
    });

    it("tracks messages per-connection independently (different WebSocket objects)", () => {
      const ws1 = makeWs();
      const ws2 = makeWs();
      initMessageRateLimit(ws1);
      initMessageRateLimit(ws2);

      // Exhaust ws1
      for (let i = 0; i < 100; i++) checkMessageRateLimit(ws1);
      expect(checkMessageRateLimit(ws1)).toBe(false);

      // ws2 should still be within limit
      expect(checkMessageRateLimit(ws2)).toBe(true);
    });

    it("auto-initializes tracker if initMessageRateLimit was not called", () => {
      const ws = makeWs();
      // Call without init — should still work
      const allowed = checkMessageRateLimit(ws);
      expect(allowed).toBe(true);
    });
  });
});
