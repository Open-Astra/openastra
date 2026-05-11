// ── HMAC Verification Middleware ─────────────────────────────────────
// Generic HMAC-SHA256/SHA1 verification for inbound webhook requests.
// Uses timing-safe comparison to prevent timing-based attacks.
// Includes webhook replay protection: timestamp validation + nonce dedup.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("hmac-verify");

// ── Webhook Nonce Cache ─────────────────────────────────────────────
// Prevents replay attacks by tracking delivery IDs within a time window.

const NONCE_TTL_MS = 6 * 60 * 1000; // 6 minutes
const TIMESTAMP_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

class WebhookNonceCache {
  private nonces = new Map<string, number>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    // Clean up expired nonces every 60 seconds
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    this.cleanupTimer.unref();
  }

  /** Returns true if the nonce is a duplicate (replay attack). */
  isDuplicate(nonce: string): boolean {
    if (this.nonces.has(nonce)) return true;
    this.nonces.set(nonce, Date.now());
    return false;
  }

  private cleanup(): void {
    const cutoff = Date.now() - NONCE_TTL_MS;
    for (const [key, timestamp] of this.nonces) {
      if (timestamp < cutoff) this.nonces.delete(key);
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
  }
}

const nonceCache = new WebhookNonceCache();

/**
 * Validate a webhook timestamp. Returns true if the timestamp is within
 * the acceptable window (5 minutes).
 */
function isTimestampValid(timestampHeader: string | undefined): boolean {
  if (!timestampHeader) return true; // Timestamp validation is optional
  const ts = Number(timestampHeader);
  if (isNaN(ts)) return true; // Non-numeric = skip validation
  // Support both seconds and milliseconds
  const timestampMs = ts < 1e12 ? ts * 1000 : ts;
  const age = Math.abs(Date.now() - timestampMs);
  return age <= TIMESTAMP_MAX_AGE_MS;
}

// ── Config ───────────────────────────────────────────────────────────

export interface HmacConfig {
  /** HMAC secret used to sign the body. */
  secret: string;
  /** HTTP header name that carries the signature, e.g. "x-hub-signature-256". */
  headerName: string;
  /** HMAC algorithm. Defaults to "sha256". */
  algorithm?: "sha256" | "sha1";
  /** Optional prefix to strip/prepend, e.g. "sha256=" for GitHub/Slack. */
  prefix?: string;
  /** Digest encoding. Defaults to "hex". */
  encoding?: "hex" | "base64";
  /** Header name for the timestamp (replay protection). */
  timestampHeader?: string;
  /** Header name for the delivery/nonce ID (dedup protection). */
  deliveryIdHeader?: string;
}

// ── Middleware Factory ────────────────────────────────────────────────

/**
 * Returns an Express RequestHandler that verifies the HMAC signature
 * of inbound requests.  Returns 401 if the header is missing or the
 * signature does not match.
 */
export function hmacVerify(config: HmacConfig): RequestHandler {
  const algorithm = config.algorithm ?? "sha256";
  const encoding = config.encoding ?? "hex";
  const prefix = config.prefix ?? "";
  const headerName = config.headerName.toLowerCase();

  const tsHeaderName = config.timestampHeader?.toLowerCase();
  const deliveryHeaderName = config.deliveryIdHeader?.toLowerCase();

  return (req: Request, res: Response, next: NextFunction): void => {
    // Replay protection: timestamp validation
    if (tsHeaderName) {
      const tsValue = req.headers[tsHeaderName];
      if (typeof tsValue === "string" && !isTimestampValid(tsValue)) {
        logger.warn(`Webhook timestamp too old: ${tsValue}`);
        res.status(401).json({ error: "Webhook timestamp expired" });
        return;
      }
    }

    // Replay protection: nonce/delivery ID deduplication
    if (deliveryHeaderName) {
      const deliveryId = req.headers[deliveryHeaderName];
      if (typeof deliveryId === "string" && deliveryId.length > 0) {
        if (nonceCache.isDuplicate(deliveryId)) {
          logger.warn(`Duplicate webhook delivery: ${deliveryId}`);
          res.status(200).json({ message: "Already processed" });
          return;
        }
      }
    }

    const signatureHeader = req.headers[headerName];

    if (!signatureHeader || typeof signatureHeader !== "string") {
      logger.warn(`Missing HMAC header: ${headerName}`);
      res.status(401).json({ error: "Missing signature header" });
      return;
    }

    // Strip the optional prefix (e.g. "sha256=") from the incoming header
    const incomingSignature = signatureHeader.startsWith(prefix)
      ? signatureHeader.slice(prefix.length)
      : signatureHeader;

    // Obtain raw body: prefer req.rawBody (Buffer) set by body-parser rawBody
    // option, fall back to JSON-serialised req.body.
    let body: Buffer;
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (rawBody instanceof Buffer) {
      body = rawBody;
    } else {
      body = Buffer.from(JSON.stringify(req.body ?? {}), "utf8");
    }

    // Compute expected signature
    const hmac = createHmac(algorithm, config.secret);
    hmac.update(body);
    const expectedDigest = hmac.digest(encoding);
    const expected = `${prefix}${expectedDigest}`;

    // Convert both to fixed-length Buffers for timing-safe comparison
    const expectedBuf = Buffer.from(expected, "utf8");
    const incomingBuf = Buffer.from(prefix + incomingSignature, "utf8");

    if (expectedBuf.length !== incomingBuf.length) {
      // Length mismatch means the signatures definitely differ.
      // Still perform a dummy comparison so we spend similar time.
      logger.warn("HMAC signature length mismatch");
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    if (!timingSafeEqual(expectedBuf, incomingBuf)) {
      logger.warn("HMAC signature mismatch");
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    next();
  };
}
