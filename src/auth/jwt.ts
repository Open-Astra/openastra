import * as jose from "jose";
import { createHash, randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

// ── JWT Token Management ────────────────────────────────────────────
// Uses jose for standard JWT signing/verification.
// Access tokens are short-lived; refresh tokens are long-lived and
// stored hashed in Postgres.
//
// Dual-key rotation: prevSecret allows zero-downtime JWT_SECRET rotation.
// Device fingerprint binding: optional dfp claim ties tokens to a device.
// JTI-based revocation: every access token carries a unique jti claim
// checked against the revoked_tokens table on each request.

const log = createLogger("jwt");

let secret: Uint8Array;
let prevSecret: Uint8Array | undefined;
let accessExpires: string;
let refreshExpires: string;
let bindToDevice: boolean = false;

// Only HS256 tokens are ever issued; pin verification to it so a token
// with a different (or "none") algorithm is rejected outright.
const VERIFY_OPTIONS: jose.JWTVerifyOptions = { algorithms: ["HS256"] };

export function initJwt(config: {
  jwtSecret: string;
  jwtSecretPrev?: string;
  accessExpires?: string;
  refreshExpires?: string;
  bindToDevice?: boolean;
}): void {
  secret = new TextEncoder().encode(config.jwtSecret);
  prevSecret = config.jwtSecretPrev
    ? new TextEncoder().encode(config.jwtSecretPrev)
    : undefined;
  accessExpires = config.accessExpires ?? "15m";
  refreshExpires = config.refreshExpires ?? "7d";
  bindToDevice = config.bindToDevice ?? false;
}

/**
 * Compute a 16-hex-char device fingerprint from user-agent + IP subnet.
 */
export function computeFingerprint(userAgent: string, ipSubnet: string): string {
  return createHash("sha256")
    .update(userAgent + ipSubnet)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Sign an access token. When bindToDevice is enabled and a fingerprint is
 * provided, the dfp claim is embedded in the token.
 * Every access token includes a unique jti (JWT ID) for revocation support.
 */
export async function signAccessToken(uid: string, fingerprint?: string): Promise<string> {
  const jti = randomUUID();
  const payload: Record<string, unknown> = { uid };
  if (bindToDevice && fingerprint) {
    payload.dfp = fingerprint;
  }
  return new jose.SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(accessExpires)
    .setSubject(uid)
    .setJti(jti)
    .sign(secret);
}

/**
 * Verify an access token.
 * Tries the current secret first. If that fails and a prevSecret is configured,
 * tries the previous secret (zero-downtime rotation).
 * When a fingerprint is provided and the token carries a dfp claim,
 * validates the fingerprint matches.
 */
export async function verifyAccessToken(
  token: string,
  fingerprint?: string
): Promise<{ uid: string }> {
  let payload: jose.JWTPayload;

  try {
    ({ payload } = await jose.jwtVerify(token, secret, VERIFY_OPTIONS));
  } catch (primaryErr) {
    if (!prevSecret) throw primaryErr;
    // Attempt verification with previous secret for rotation support
    ({ payload } = await jose.jwtVerify(token, prevSecret, VERIFY_OPTIONS));
  }

  const uid = payload.sub ?? (payload.uid as string | undefined);
  if (!uid) throw new Error("Token missing uid");

  // Reject refresh tokens used as access tokens
  if (payload.type === "refresh") {
    throw new Error("Refresh token cannot be used as access token");
  }

  // Device fingerprint validation. When binding is enabled the claim is
  // mandatory — a token without it (or presented without a fingerprint)
  // is rejected rather than silently accepted.
  if (bindToDevice) {
    if (!fingerprint || payload.dfp !== fingerprint) {
      throw new Error("Token device fingerprint mismatch");
    }
  } else if (fingerprint && payload.dfp !== undefined && payload.dfp !== fingerprint) {
    throw new Error("Token device fingerprint mismatch");
  }

  // JTI revocation check — reject tokens that have been explicitly revoked
  // Also checks the "all:<uid>" sentinel for bulk user revocations.
  const jti = payload.jti;
  if (jti) {
    const revoked = await isTokenRevoked(jti);
    if (revoked) {
      throw new Error("Token has been revoked");
    }
  }
  // Check sentinel revocation for this user (covers revokeAllAccessTokens).
  // Only tokens issued at or before the revocation are rejected, so a user
  // can log in again immediately after logout / a forced sign-out.
  const revokedAt = await getBulkRevocationTime(uid);
  if (revokedAt !== null) {
    const issuedAtMs = (payload.iat ?? 0) * 1000;
    // iat has 1s resolution — treat the whole second of revocation as revoked
    if (issuedAtMs <= revokedAt) {
      throw new Error("All tokens for this user have been revoked");
    }
  }

  return { uid };
}

/**
 * Verify a refresh token. Enforces type === "refresh" to prevent
 * access tokens from being used as refresh tokens.
 */
export async function verifyRefreshToken(token: string): Promise<{ uid: string }> {
  let payload: jose.JWTPayload;

  try {
    ({ payload } = await jose.jwtVerify(token, secret, VERIFY_OPTIONS));
  } catch (primaryErr) {
    if (!prevSecret) throw primaryErr;
    ({ payload } = await jose.jwtVerify(token, prevSecret, VERIFY_OPTIONS));
  }

  const uid = payload.sub ?? (payload.uid as string | undefined);
  if (!uid) throw new Error("Token missing uid");

  if (payload.type !== "refresh") {
    throw new Error("Not a refresh token");
  }

  return { uid };
}

export async function signRefreshToken(uid: string): Promise<string> {
  return new jose.SignJWT({ uid, type: "refresh" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(refreshExpires)
    .setSubject(uid)
    .sign(secret);
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function getRefreshExpiresMs(): number {
  // Parse duration string like "7d", "24h", "30m"
  const match = refreshExpires.match(/^(\d+)([dhms])$/);
  if (!match) return 7 * 24 * 60 * 60 * 1000; // default 7d

  const [, num, unit] = match;
  const multipliers: Record<string, number> = {
    d: 86_400_000,
    h: 3_600_000,
    m: 60_000,
    s: 1_000,
  };

  return parseInt(num!, 10) * (multipliers[unit!] ?? 86_400_000);
}

// ── Token Revocation ────────────────────────────────────────────────

/**
 * Check if an access token JTI has been revoked.
 */
export async function isTokenRevoked(jti: string): Promise<boolean> {
  try {
    const pool = getPool();
    const { rows } = await pool.query<{ jti: string }>(
      "SELECT jti FROM revoked_tokens WHERE jti = $1",
      [jti],
    );
    return rows.length > 0;
  } catch (err) {
    // Fail-closed — if the revocation table is unreachable, reject the
    // token. Availability is less critical than allowing revoked tokens.
    log.error("Revocation check failed (fail-closed):", err);
    return true;
  }
}

/**
 * When were all of this user's access tokens revoked? Returns the
 * revocation time in ms, or null if there is no active bulk revocation.
 * Fails closed (returns "now") if the table is unreachable.
 */
async function getBulkRevocationTime(uid: string): Promise<number | null> {
  try {
    const { rows } = await getPool().query<{ revoked_at: Date | null }>(
      "SELECT revoked_at FROM revoked_tokens WHERE jti = $1 AND exp > NOW()",
      [`all:${uid}`],
    );
    if (rows.length === 0) return null;
    const at = rows[0]!.revoked_at;
    return at ? new Date(at).getTime() : Date.now();
  } catch (err) {
    log.error("Bulk revocation check failed (fail-closed):", err);
    return Date.now();
  }
}

/**
 * Revoke a specific access token by its JTI.
 * The exp date is stored so expired revocations can be pruned by cron.
 */
export async function revokeToken(jti: string, exp: Date, uid?: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO revoked_tokens (jti, uid, exp)
     VALUES ($1, $2, $3)
     ON CONFLICT (jti) DO NOTHING`,
    [jti, uid ?? null, exp],
  );
  log.dim(`Revoked token jti=${jti}`);
}

/**
 * Revoke all active access tokens for a user by inserting a revocation
 * entry that covers the maximum access token lifetime.
 * Since we cannot enumerate all outstanding JTIs, we insert a sentinel
 * row with jti = "all:<uid>" that verifyAccessToken also checks.
 */
export async function revokeAllAccessTokens(uid: string): Promise<void> {
  const pool = getPool();
  // Parse accessExpires to compute the furthest possible expiration
  const maxExpMs = parseExpiresMs(accessExpires);
  const exp = new Date(Date.now() + maxExpMs);
  const sentinelJti = `all:${uid}`;

  await pool.query(
    `INSERT INTO revoked_tokens (jti, uid, exp)
     VALUES ($1, $2, $3)
     ON CONFLICT (jti) DO UPDATE SET exp = EXCLUDED.exp, revoked_at = NOW()`,
    [sentinelJti, uid, exp],
  );
  log.dim(`Revoked all access tokens for uid=${uid}`);
}

/**
 * Prune expired revocation entries. Called by cron scheduler.
 */
export async function pruneExpiredRevocations(): Promise<number> {
  const pool = getPool();
  const result = await pool.query(
    "DELETE FROM revoked_tokens WHERE exp < NOW()",
  );
  const count = result.rowCount ?? 0;
  if (count > 0) {
    log.dim(`Pruned ${count} expired revoked token(s)`);
  }
  return count;
}

/**
 * Decode a token without verification to extract claims (jti, exp, sub).
 * Used by the revoke endpoint when we need the claims from a valid token.
 */
export function decodeTokenUnsafe(token: string): { jti?: string; exp?: number; sub?: string; uid?: string } {
  try {
    const decoded = jose.decodeJwt(token);
    return {
      jti: decoded.jti,
      exp: decoded.exp,
      sub: decoded.sub,
      uid: decoded.uid as string | undefined,
    };
  } catch {
    return {};
  }
}

// ── Internal Helpers ────────────────────────────────────────────────

/**
 * Parse a duration string like "15m", "1h", "7d" into milliseconds.
 */
function parseExpiresMs(expires: string): number {
  const match = expires.match(/^(\d+)([dhms])$/);
  if (!match) return 15 * 60 * 1000; // default 15m
  const [, num, unit] = match;
  const multipliers: Record<string, number> = {
    d: 86_400_000,
    h: 3_600_000,
    m: 60_000,
    s: 1_000,
  };
  return parseInt(num!, 10) * (multipliers[unit!] ?? 60_000);
}
