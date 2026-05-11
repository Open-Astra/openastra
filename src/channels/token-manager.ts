// ── Channel Token Management ──────────────────────────────────────────
// Manages per-workspace channel authentication tokens (Telegram, Discord, Slack).
// Tokens are stored in workspace_secrets with audit logging on retrieval.
//
// Fallback chain:
//   1. Workspace-specific token (workspace_secrets table)
//   2. Environment variable (e.g., TELEGRAM_BOT_TOKEN)
//   3. undefined (channel disabled)

import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("channel-token-manager");

export type ChannelTokenKey =
  | "TELEGRAM_BOT_TOKEN"
  | "DISCORD_BOT_TOKEN"
  | "SLACK_BOT_TOKEN"
  | "WHATSAPP_API_KEY"
  | "SIGNAL_API_KEY"
  | "GITHUB_WEBHOOK_SECRET"
  | "LINEAR_API_KEY";

const ENV_VAR_NAMES: Record<ChannelTokenKey, string> = {
  TELEGRAM_BOT_TOKEN: "TELEGRAM_BOT_TOKEN",
  DISCORD_BOT_TOKEN: "DISCORD_BOT_TOKEN",
  SLACK_BOT_TOKEN: "SLACK_BOT_TOKEN",
  WHATSAPP_API_KEY: "WHATSAPP_API_KEY",
  SIGNAL_API_KEY: "SIGNAL_API_KEY",
  GITHUB_WEBHOOK_SECRET: "GITHUB_WEBHOOK_SECRET",
  LINEAR_API_KEY: "LINEAR_API_KEY",
};

/**
 * Retrieve a channel token with workspace override support.
 * Falls back to env var if workspace token not set.
 * Logs token access to secret_audit_log for compliance.
 */
export async function getChannelToken(
  workspaceId: string | undefined,
  tokenKey: ChannelTokenKey,
  uid?: string,
): Promise<string | undefined> {
  // Try workspace-specific token first
  if (workspaceId) {
    try {
      const pool = getPool();
      const { rows } = await pool.query<{ secret_value: string; set_by: string }>(
        `SELECT secret_value, set_by
         FROM workspace_secrets
         WHERE workspace_id = $1 AND secret_key = $2 AND (expires_at IS NULL OR expires_at > NOW())
         LIMIT 1`,
        [workspaceId, tokenKey],
      );

      if (rows.length > 0) {
        const token = rows[0]!.secret_value;

        // Audit log the token retrieval
        if (uid) {
          pool.query(
            `INSERT INTO secret_audit_log (user_id, secret_key, action, workspace_id, timestamp)
             VALUES ($1, $2, $3, $4, NOW())`,
            [uid, tokenKey, "retrieved", workspaceId],
          ).catch(() => {});
        }

        return token;
      }
    } catch (err) {
      logger.error(`getChannelToken(${workspaceId}, ${tokenKey}) failed:`, (err as Error).message);
    }
  }

  // Fall back to environment variable
  const envVarName = ENV_VAR_NAMES[tokenKey];
  const envToken = process.env[envVarName];

  if (envToken && uid && workspaceId) {
    // Audit: env var fallback used (not a security issue, just informational)
    try {
      const pool = getPool();
      pool.query(
        `INSERT INTO secret_audit_log (user_id, secret_key, action, workspace_id, timestamp)
         VALUES ($1, $2, $3, $4, NOW())`,
        [uid, tokenKey, "fallback_env", workspaceId],
      ).catch(() => {});
    } catch {
      // Audit failures must not block token retrieval
    }
  }

  return envToken;
}

/**
 * Set a workspace-specific channel token with optional expiry.
 * Overwrites existing token if present.
 */
export async function setChannelToken(
  workspaceId: string,
  tokenKey: ChannelTokenKey,
  token: string,
  uid: string,
  expiresInDays?: number,
): Promise<void> {
  const pool = getPool();
  const expiresAt = expiresInDays
    ? new Date(Date.now() + expiresInDays * 86_400_000)
    : null;

  try {
    await pool.query(
      `INSERT INTO workspace_secrets (workspace_id, secret_key, secret_value, set_by, expires_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (workspace_id, secret_key)
       DO UPDATE SET
         secret_value = EXCLUDED.secret_value,
         set_by = EXCLUDED.set_by,
         expires_at = EXCLUDED.expires_at,
         updated_at = NOW()`,
      [workspaceId, tokenKey, token, uid, expiresAt],
    );

    logger.info(`Channel token set: ${workspaceId}/${tokenKey} by ${uid}`);
  } catch (err) {
    logger.error(`setChannelToken failed:`, (err as Error).message);
    throw err;
  }
}

/**
 * Rotate (refresh) a channel token by setting an expiration date.
 * Users must provide a new token via setChannelToken within the window.
 */
export async function rotateChannelToken(
  workspaceId: string,
  tokenKey: ChannelTokenKey,
  uid: string,
  expiresInDays: number = 30,
): Promise<void> {
  const pool = getPool();
  const expiresAt = new Date(Date.now() + expiresInDays * 86_400_000);

  try {
    await pool.query(
      `UPDATE workspace_secrets
       SET expires_at = $1, updated_at = NOW()
       WHERE workspace_id = $2 AND secret_key = $3`,
      [expiresAt, workspaceId, tokenKey],
    );

    logger.info(`Channel token rotation initiated: ${workspaceId}/${tokenKey} by ${uid} (expires in ${expiresInDays}d)`);
  } catch (err) {
    logger.error(`rotateChannelToken failed:`, (err as Error).message);
    throw err;
  }
}

/**
 * Delete a workspace-specific channel token (forces fallback to env var).
 */
export async function deleteChannelToken(
  workspaceId: string,
  tokenKey: ChannelTokenKey,
  uid: string,
): Promise<void> {
  const pool = getPool();

  try {
    await pool.query(
      `DELETE FROM workspace_secrets
       WHERE workspace_id = $1 AND secret_key = $2`,
      [workspaceId, tokenKey],
    );

    logger.info(`Channel token deleted: ${workspaceId}/${tokenKey} by ${uid}`);
  } catch (err) {
    logger.error(`deleteChannelToken failed:`, (err as Error).message);
    throw err;
  }
}
