// ── Consent Management ────────────────────────────────────────────────
// Manages user consent records per workspace.
// Consent types: 'memory_collection', 'analytics', 'ai_training', 'data_sharing'

import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("consent");

export const CONSENT_TYPES = [
  "memory_collection",
  "analytics",
  "ai_training",
  "data_sharing",
] as const;

export type ConsentType = (typeof CONSENT_TYPES)[number];

// ── Types ─────────────────────────────────────────────────────────────

export interface UserConsent {
  workspaceId: string;
  uid: string;
  consentType: string;
  granted: boolean;
  grantedAt: string;
  expiresAt: string | null;
}

// ── DB Row ────────────────────────────────────────────────────────────

interface ConsentRow {
  workspace_id: string;
  uid: string;
  consent_type: string;
  granted: boolean;
  granted_at: string;
  expires_at: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────

function rowToConsent(row: ConsentRow): UserConsent {
  return {
    workspaceId: row.workspace_id,
    uid: row.uid,
    consentType: row.consent_type,
    granted: row.granted,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
  };
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Check whether a user has granted consent for a given type.
 * Returns false if no record exists (deny-by-default).
 * Expired consents are treated as not granted.
 */
export async function checkConsent(
  workspaceId: string,
  uid: string,
  consentType: string,
): Promise<boolean> {
  const pool = getPool();

  const { rows } = await pool.query<{ granted: boolean }>(
    `SELECT granted
     FROM user_consents
     WHERE workspace_id = $1
       AND uid = $2
       AND consent_type = $3
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [workspaceId, uid, consentType],
  );

  if (rows.length === 0) return false;
  return rows[0]!.granted;
}

/**
 * Record or update a consent decision for a user.
 */
export async function recordConsent(
  workspaceId: string,
  uid: string,
  consentType: string,
  granted: boolean,
  expiresAt?: Date,
): Promise<void> {
  const pool = getPool();

  await pool.query(
    `INSERT INTO user_consents (workspace_id, uid, consent_type, granted, granted_at, expires_at)
     VALUES ($1, $2, $3, $4, NOW(), $5)
     ON CONFLICT (workspace_id, uid, consent_type) DO UPDATE
       SET granted    = EXCLUDED.granted,
           granted_at = NOW(),
           expires_at = EXCLUDED.expires_at`,
    [workspaceId, uid, consentType, granted, expiresAt ?? null],
  );

  log.info(
    `Consent recorded: uid=${uid} type=${consentType} granted=${granted} workspace=${workspaceId}`,
  );
}

/**
 * List all consent records for a user in a workspace.
 */
export async function listConsents(
  workspaceId: string,
  uid: string,
): Promise<UserConsent[]> {
  const pool = getPool();

  const { rows } = await pool.query<ConsentRow>(
    `SELECT workspace_id, uid, consent_type, granted, granted_at, expires_at
     FROM user_consents
     WHERE workspace_id = $1 AND uid = $2
     ORDER BY consent_type`,
    [workspaceId, uid],
  );

  return rows.map(rowToConsent);
}

/**
 * Revoke (delete) a specific consent type for a user.
 * Returns true if a record was deleted.
 */
export async function revokeConsent(
  workspaceId: string,
  uid: string,
  consentType: string,
): Promise<boolean> {
  const pool = getPool();

  const result = await pool.query(
    `DELETE FROM user_consents
     WHERE workspace_id = $1 AND uid = $2 AND consent_type = $3`,
    [workspaceId, uid, consentType],
  );

  const deleted = (result.rowCount ?? 0) > 0;
  if (deleted) {
    log.info(
      `Consent revoked: uid=${uid} type=${consentType} workspace=${workspaceId}`,
    );
  }
  return deleted;
}
