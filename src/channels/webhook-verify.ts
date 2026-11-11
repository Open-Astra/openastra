import { timingSafeEqual } from "node:crypto";
import type { Request } from "express";

// ── Inbound Webhook Verification Helpers ────────────────────────────
// Channel webhooks are unauthenticated HTTP endpoints: the only thing
// standing between the internet and "inject a message as any sender" is
// the provider's signature (or, for providers that do not sign, a shared
// secret). Rules for every adapter:
//
//   • HMACs are computed over the RAW request bytes (stashed by the
//     express.json() verify hook), never over JSON.stringify(req.body) —
//     re-serialising changes key order/whitespace and breaks real
//     signatures.
//   • Comparisons are constant-time.
//   • No secret configured → the request is rejected, unless the operator
//     explicitly sets ALLOW_UNSIGNED_WEBHOOKS=true (local development).

/** Raw request body captured by the global express.json() verify hook. */
export function getRawBody(req: Request): Buffer | undefined {
  const raw = (req as unknown as { rawBody?: unknown }).rawBody;
  if (Buffer.isBuffer(raw)) return raw;
  // express.raw() / express.text() leave the payload on req.body
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body);
  return undefined;
}

/** Constant-time string comparison. False for empty/undefined inputs. */
export function safeEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try {
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

/** True only when the operator has opted in to unsigned webhooks. */
export function unsignedWebhooksAllowed(): boolean {
  return process.env.ALLOW_UNSIGNED_WEBHOOKS === "true" && process.env.NODE_ENV !== "production";
}

/**
 * Shared-secret check for providers that cannot sign requests
 * (BlueBubbles, signal-cli-rest-api, generic inbound-email relays).
 * Accepts the secret via `X-Webhook-Secret`, `Authorization: Bearer`,
 * HTTP Basic password, or — only when `allowQuery` is set, for providers
 * that can configure nothing but a URL — the `secret` query parameter.
 */
export function verifySharedSecret(
  req: Request,
  expected: string | undefined,
  opts: { allowQuery?: boolean } = {},
): boolean {
  if (!expected) return unsignedWebhooksAllowed();

  const header = req.headers["x-webhook-secret"];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (safeEqual(fromHeader, expected)) return true;

  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ") && safeEqual(auth.slice(7), expected)) return true;
  if (auth?.startsWith("Basic ")) {
    const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
    const password = decoded.slice(decoded.indexOf(":") + 1);
    if (safeEqual(password, expected)) return true;
  }

  if (opts.allowQuery) {
    const q = req.query["secret"];
    if (typeof q === "string" && safeEqual(q, expected)) return true;
  }
  return false;
}
