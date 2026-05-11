// ── Conversation-Scoped Ephemeral Memory ─────────────────────────────
// Key-value store that lives only for the duration of a session.

import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("ephemeral-memory");

export interface EphemeralMemory {
  id: string;
  sessionId: string;
  key: string;
  value: unknown;
  createdAt: Date;
  expiresAt: Date;
}

const DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 24 hours

export async function setEphemeral(
  sessionId: string,
  key: string,
  value: unknown,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<void> {
  const pool = getPool();
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  await pool.query(
    `INSERT INTO ephemeral_memory (id, session_id, key, value, expires_at)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (session_id, key)
     DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
    [id, sessionId, key, JSON.stringify(value), expiresAt],
  );
}

export async function getEphemeral(sessionId: string, key: string): Promise<unknown | null> {
  const pool = getPool();
  const { rows } = await pool.query<{ value: unknown }>(
    `SELECT value FROM ephemeral_memory
     WHERE session_id = $1 AND key = $2 AND expires_at > NOW()`,
    [sessionId, key],
  );
  return rows[0]?.value ?? null;
}

export async function getAllEphemeral(sessionId: string): Promise<Record<string, unknown>> {
  const pool = getPool();
  const { rows } = await pool.query<{ key: string; value: unknown }>(
    `SELECT key, value FROM ephemeral_memory
     WHERE session_id = $1 AND expires_at > NOW()`,
    [sessionId],
  );
  const result: Record<string, unknown> = {};
  for (const row of rows) result[row.key] = row.value;
  return result;
}

export async function deleteEphemeral(sessionId: string, key: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `DELETE FROM ephemeral_memory WHERE session_id = $1 AND key = $2`,
    [sessionId, key],
  );
}

export async function clearEphemeral(sessionId: string): Promise<number> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM ephemeral_memory WHERE session_id = $1`,
    [sessionId],
  );
  return rowCount ?? 0;
}

export async function purgeExpiredEphemeral(): Promise<number> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM ephemeral_memory WHERE expires_at <= NOW()`,
  );
  const count = rowCount ?? 0;
  if (count > 0) logger.info(`Purged ${count} expired ephemeral memory entries`);
  return count;
}
