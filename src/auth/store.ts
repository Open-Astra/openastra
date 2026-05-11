import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { hashRefreshToken, getRefreshExpiresMs } from "./jwt.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("auth-store");

// ── User Types ──────────────────────────────────────────────────────

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string | null;
  tier: string;
  fcmToken: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ── User CRUD ───────────────────────────────────────────────────────

export async function createUser(
  email: string,
  passwordHash: string,
  displayName?: string,
): Promise<UserRecord> {
  const id = randomUUID();
  const pool = getPool();

  const { rows } = await pool.query<UserRecord>(
    `INSERT INTO users (id, email, password_hash, display_name)
     VALUES ($1, $2, $3, $4)
     RETURNING id, email, password_hash AS "passwordHash",
       display_name AS "displayName", tier, fcm_token AS "fcmToken",
       created_at AS "createdAt", updated_at AS "updatedAt"`,
    [id, email.toLowerCase(), passwordHash, displayName ?? null],
  );

  return rows[0]!;
}

export async function findUserByEmail(email: string): Promise<UserRecord | null> {
  const pool = getPool();
  const { rows } = await pool.query<UserRecord>(
    `SELECT id, email, password_hash AS "passwordHash",
       display_name AS "displayName", tier, fcm_token AS "fcmToken",
       created_at AS "createdAt", updated_at AS "updatedAt"
     FROM users WHERE email = $1`,
    [email.toLowerCase()],
  );
  return rows[0] ?? null;
}

export async function findUserById(id: string): Promise<UserRecord | null> {
  const pool = getPool();
  const { rows } = await pool.query<UserRecord>(
    `SELECT id, email, password_hash AS "passwordHash",
       display_name AS "displayName", tier, fcm_token AS "fcmToken",
       created_at AS "createdAt", updated_at AS "updatedAt"
     FROM users WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

// ── Refresh Tokens ──────────────────────────────────────────────────

export async function storeRefreshToken(
  userId: string,
  rawToken: string,
  tokenFamily?: string,
): Promise<void> {
  const pool = getPool();
  const tokenHash = hashRefreshToken(rawToken);
  const expiresAt = new Date(Date.now() + getRefreshExpiresMs());
  const family = tokenFamily ?? randomUUID();

  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, token_family)
     VALUES ($1, $2, $3, $4)`,
    [userId, tokenHash, expiresAt, family],
  );
}

export async function revokeRefreshToken(rawToken: string): Promise<boolean> {
  const pool = getPool();
  const tokenHash = hashRefreshToken(rawToken);

  const { rowCount } = await pool.query(
    `UPDATE refresh_tokens SET revoked = true
     WHERE token_hash = $1 AND revoked = false`,
    [tokenHash],
  );

  return (rowCount ?? 0) > 0;
}

export async function revokeAllUserTokens(userId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    "UPDATE refresh_tokens SET revoked = true WHERE user_id = $1",
    [userId],
  );
}

export async function isRefreshTokenValid(rawToken: string): Promise<boolean> {
  const pool = getPool();
  const tokenHash = hashRefreshToken(rawToken);

  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM refresh_tokens
     WHERE token_hash = $1 AND revoked = false AND expires_at > NOW()`,
    [tokenHash],
  );

  return rows.length > 0;
}

/**
 * Get the token family for a refresh token (by raw token).
 * Returns null if the token does not exist.
 */
export async function getTokenFamily(rawToken: string): Promise<string | null> {
  const pool = getPool();
  const tokenHash = hashRefreshToken(rawToken);

  const { rows } = await pool.query<{ token_family: string | null }>(
    "SELECT token_family FROM refresh_tokens WHERE token_hash = $1",
    [tokenHash],
  );

  return rows[0]?.token_family ?? null;
}

/**
 * Check if a refresh token was already revoked (replay detection).
 * A revoked token that is presented again means the rotation chain was
 * compromised — the attacker is replaying an old token.
 */
export async function isRefreshTokenRevoked(rawToken: string): Promise<boolean> {
  const pool = getPool();
  const tokenHash = hashRefreshToken(rawToken);

  const { rows } = await pool.query<{ revoked: boolean }>(
    "SELECT revoked FROM refresh_tokens WHERE token_hash = $1",
    [tokenHash],
  );

  if (rows.length === 0) return false;
  return rows[0]!.revoked;
}

/**
 * Revoke ALL refresh tokens in a token family (token family revocation).
 * Used when replay is detected — compromises the entire rotation chain.
 * Returns the number of tokens revoked.
 */
export async function revokeTokenFamily(tokenFamily: string): Promise<number> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    "UPDATE refresh_tokens SET revoked = true WHERE token_family = $1 AND revoked = false",
    [tokenFamily],
  );
  const count = rowCount ?? 0;
  if (count > 0) {
    log.warn(`Revoked ${count} token(s) in family ${tokenFamily} (replay detected)`);
  }
  return count;
}

/**
 * Get the user ID associated with a refresh token (even if revoked).
 * Used during replay detection to identify which user was compromised.
 */
export async function getUserIdByRefreshToken(rawToken: string): Promise<string | null> {
  const pool = getPool();
  const tokenHash = hashRefreshToken(rawToken);

  const { rows } = await pool.query<{ user_id: string }>(
    "SELECT user_id FROM refresh_tokens WHERE token_hash = $1",
    [tokenHash],
  );

  return rows[0]?.user_id ?? null;
}
