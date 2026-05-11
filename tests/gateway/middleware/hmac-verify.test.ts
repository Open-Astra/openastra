import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";

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

import { hmacVerify } from "../../../src/gateway/middleware/hmac-verify.js";
import {
  createMockRequest,
  createMockResponse,
  createMockNext,
} from "../../helpers/mock-express.js";

// ── Helpers ─────────────────────────────────────────────────────────

const SECRET = "test-hmac-secret";
const HEADER = "x-hub-signature-256";
const PREFIX = "sha256=";

function computeSignature(body: string | Buffer, secret = SECRET): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(typeof body === "string" ? Buffer.from(body, "utf8") : body);
  return PREFIX + hmac.digest("hex");
}

function makeMiddleware(overrides = {}) {
  return hmacVerify({
    secret: SECRET,
    headerName: HEADER,
    prefix: PREFIX,
    ...overrides,
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe("hmacVerify middleware", () => {
  let res: ReturnType<typeof createMockResponse>;
  let next: ReturnType<typeof createMockNext>;

  beforeEach(() => {
    res = createMockResponse();
    next = createMockNext();
  });

  describe("valid HMAC signature", () => {
    it("calls next() when the signature is correct", () => {
      const body = { event: "push", ref: "refs/heads/main" };
      const rawBody = Buffer.from(JSON.stringify(body), "utf8");
      const sig = computeSignature(rawBody);

      const req = createMockRequest({
        headers: { [HEADER]: sig },
        rawBody,
        body,
      });

      const mw = makeMiddleware();
      mw(req as never, res as never, next);

      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("accepts a sha256 signature computed from the rawBody Buffer", () => {
      const rawBody = Buffer.from('{"key":"value"}', "utf8");
      const sig = computeSignature(rawBody);

      const req = createMockRequest({
        headers: { [HEADER]: sig },
        rawBody,
        body: { key: "value" },
      });

      makeMiddleware()(req as never, res as never, next);
      expect(next).toHaveBeenCalledOnce();
    });
  });

  describe("missing signature header", () => {
    it("returns 401 when the signature header is absent", () => {
      const req = createMockRequest({
        headers: {},
        body: { event: "ping" },
      });

      makeMiddleware()(req as never, res as never, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("Missing") }),
      );
    });
  });

  describe("invalid signature", () => {
    it("returns 401 when the signature does not match the body", () => {
      const body = { event: "push" };
      const rawBody = Buffer.from(JSON.stringify(body), "utf8");
      const wrongSig = PREFIX + "a".repeat(64); // valid-length hex but wrong

      const req = createMockRequest({
        headers: { [HEADER]: wrongSig },
        rawBody,
        body,
      });

      makeMiddleware()(req as never, res as never, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: "Invalid signature" }),
      );
    });

    it("returns 401 when the payload differs from what was signed", () => {
      const signedBody = Buffer.from('{"original":true}', "utf8");
      const sig = computeSignature(signedBody);

      // Send a different body
      const tamperedBody = Buffer.from('{"tampered":true}', "utf8");
      const req = createMockRequest({
        headers: { [HEADER]: sig },
        rawBody: tamperedBody,
        body: { tampered: true },
      });

      makeMiddleware()(req as never, res as never, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it("returns 401 when signed with a different secret", () => {
      const body = { event: "push" };
      const rawBody = Buffer.from(JSON.stringify(body), "utf8");
      // Sign with wrong secret
      const wrongSig = PREFIX + createHmac("sha256", "wrong-secret").update(rawBody).digest("hex");

      const req = createMockRequest({
        headers: { [HEADER]: wrongSig },
        rawBody,
        body,
      });

      makeMiddleware()(req as never, res as never, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });
  });

  describe("timing-safe comparison", () => {
    it("uses timingSafeEqual — valid sig of different length gets 401 before comparison", () => {
      // A signature that is valid hex but length-mismatched (no prefix)
      const body = { event: "push" };
      const rawBody = Buffer.from(JSON.stringify(body), "utf8");
      const hmac = createHmac("sha256", SECRET).update(rawBody);
      const shortSig = hmac.digest("hex").slice(0, 10); // truncated

      const req = createMockRequest({
        headers: { [HEADER]: PREFIX + shortSig },
        rawBody,
        body,
      });

      makeMiddleware()(req as never, res as never, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });
  });

  describe("replay protection — expired timestamp", () => {
    it("returns 401 when the webhook timestamp is older than 5 minutes", () => {
      const body = { event: "push" };
      const rawBody = Buffer.from(JSON.stringify(body), "utf8");
      const sig = computeSignature(rawBody);

      // Timestamp 10 minutes in the past (in seconds)
      const oldTimestamp = Math.floor(Date.now() / 1000) - 600;

      const req = createMockRequest({
        headers: {
          [HEADER]: sig,
          "x-webhook-timestamp": String(oldTimestamp),
        },
        rawBody,
        body,
      });

      const mw = hmacVerify({
        secret: SECRET,
        headerName: HEADER,
        prefix: PREFIX,
        timestampHeader: "x-webhook-timestamp",
      });

      mw(req as never, res as never, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("expired") }),
      );
    });
  });

  describe("replay protection — duplicate nonce", () => {
    it("returns 200 Already Processed for a duplicate delivery ID", () => {
      const body = { event: "ping" };
      const rawBody = Buffer.from(JSON.stringify(body), "utf8");
      const sig = computeSignature(rawBody);
      const deliveryId = `dedup-test-${Date.now()}-${Math.random()}`;

      const mw = hmacVerify({
        secret: SECRET,
        headerName: HEADER,
        prefix: PREFIX,
        deliveryIdHeader: "x-delivery-id",
      });

      const makeReq = () =>
        createMockRequest({
          headers: {
            [HEADER]: sig,
            "x-delivery-id": deliveryId,
          },
          rawBody,
          body,
        });

      // First call: should pass through
      mw(makeReq() as never, res as never, next);
      expect(next).toHaveBeenCalledOnce();

      // Second call with same delivery ID: should be deduplicated
      const res2 = createMockResponse();
      const next2 = createMockNext();
      mw(makeReq() as never, res2 as never, next2);
      expect(next2).not.toHaveBeenCalled();
      expect(res2.status).toHaveBeenCalledWith(200);
      expect(res2.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Already processed" }),
      );
    });
  });
});
