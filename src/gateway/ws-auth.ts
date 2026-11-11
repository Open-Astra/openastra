import type { IncomingMessage } from "http";
import type { WebSocket } from "ws";
import { verifyAccessToken, decodeTokenUnsafe, computeFingerprint } from "../auth/jwt.js";

// ── WebSocket Auth Helpers ──────────────────────────────────────────
// Shared by /ws and /playground/ws so both enforce the same rules.

/** Max inbound WebSocket frame. Chat frames are capped at 10k chars. */
export const WS_MAX_PAYLOAD_BYTES = 256 * 1024;

function allowedOrigins(): string[] {
  return (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

/**
 * Cross-site WebSocket hijacking guard. Browsers always send Origin on a
 * WebSocket handshake; non-browser clients usually do not. A request with
 * an Origin must match ALLOWED_ORIGINS in production. Requests without an
 * Origin are allowed (they cannot ride a victim's browser session).
 */
export function isAllowedWsOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (process.env.NODE_ENV !== "production") return true;
  return allowedOrigins().includes(origin);
}

/**
 * Token from `Authorization: Bearer`, the `bearer.<jwt>` subprotocol, or
 * (legacy) the `?token=` query parameter. Prefer the header/subprotocol:
 * query strings end up in proxy and access logs.
 */
export function extractWsToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);

  const protoHeader = req.headers["sec-websocket-protocol"];
  const protocols = (Array.isArray(protoHeader) ? protoHeader.join(",") : protoHeader ?? "")
    .split(",")
    .map((p) => p.trim());
  const bearer = protocols.find((p) => p.startsWith("bearer."));
  if (bearer) return bearer.slice("bearer.".length);

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  return url.searchParams.get("token");
}

/** Real peer address. Honours X-Forwarded-For only when TRUST_PROXY is set. */
export function wsClientIp(req: IncomingMessage): string {
  const trust = process.env.TRUST_PROXY;
  if (trust && trust !== "false" && trust !== "0") {
    const forwarded = req.headers["x-forwarded-for"];
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (raw) {
      // The right-most entry is the one appended by our own proxy.
      const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
      const hops = /^\d+$/.test(trust) ? Math.max(1, parseInt(trust, 10)) : 1;
      const picked = parts[Math.max(0, parts.length - hops)];
      if (picked) return picked;
    }
  }
  return req.socket.remoteAddress ?? "unknown";
}

export interface WsAuthResult {
  uid: string;
  /** Access-token expiry (ms since epoch), when the token carries one. */
  expiresAt?: number;
}

/** Verify the handshake token (signature, revocation, device binding). */
export async function authenticateWs(req: IncomingMessage, token: string): Promise<WsAuthResult> {
  let fingerprint: string | undefined;
  if (process.env.BIND_JWT_TO_DEVICE === "true") {
    const ua = (req.headers["user-agent"] as string | undefined) ?? "";
    fingerprint = computeFingerprint(ua, wsClientIp(req));
  }
  const { uid } = await verifyAccessToken(token, fingerprint);
  const { exp } = decodeTokenUnsafe(token);
  return { uid, expiresAt: exp ? exp * 1000 : undefined };
}

/**
 * Close the socket when its access token expires, so a connection cannot
 * outlive the credential that opened it (or a revocation of it).
 */
export function closeOnTokenExpiry(ws: WebSocket, expiresAt: number | undefined): void {
  if (!expiresAt) return;
  const delay = Math.max(0, expiresAt - Date.now());
  // setTimeout caps at ~24.8 days; access tokens are far shorter.
  const timer = setTimeout(() => {
    try {
      ws.close(4001, "Token expired");
    } catch { /* already closed */ }
  }, Math.min(delay, 2_147_000_000));
  timer.unref();
  ws.on("close", () => clearTimeout(timer));
}
