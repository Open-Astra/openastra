import { createLogger } from "../utils/logger.js";
import { getPool } from "../config/postgres.js";

const log = createLogger("workspace-secrets");

// ── Per-Workspace Secret Storage ─────────────────────────────────────
// Tenants can supply their own API keys, overriding platform-level env vars.
// Values are stored in the workspace_secrets table (migration 023).
// Secret values are NEVER returned by list operations — metadata only.

/**
 * Union of env var names that workspaces are allowed to override.
 * Includes inference keys, channel tokens, and third-party integrations.
 */
export type WorkspaceSecretKey =
  | "OPENAI_API_KEY"
  | "ANTHROPIC_API_KEY"
  | "GEMINI_API_KEY"
  | "GROK_API_KEY"
  | "GROQ_API_KEY"
  | "BRAVE_API_KEY"
  | "RESEND_API_KEY"
  | "JIRA_API_TOKEN"
  | "TELEGRAM_BOT_TOKEN"
  | "DISCORD_BOT_TOKEN"
  | "SLACK_BOT_TOKEN"
  | "WHATSAPP_API_KEY"
  | "SIGNAL_API_KEY"
  | "GITHUB_WEBHOOK_SECRET"
  | "LINEAR_API_KEY";

export const WORKSPACE_SECRET_KEYS: WorkspaceSecretKey[] = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GROK_API_KEY",
  "GROQ_API_KEY",
  "BRAVE_API_KEY",
  "RESEND_API_KEY",
  "JIRA_API_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
  "SLACK_BOT_TOKEN",
  "WHATSAPP_API_KEY",
  "SIGNAL_API_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "LINEAR_API_KEY",
];

export interface WorkspaceSecretMeta {
  key: WorkspaceSecretKey;
  setBy: string;
  updatedAt: Date;
  expiresAt: Date | null;
}

// ── Queries ──────────────────────────────────────────────────────────

/**
 * Retrieve a workspace-scoped secret value.
 * Returns undefined if the key is not set or has expired.
 */
export async function getWorkspaceSecret(
  workspaceId: string,
  key: WorkspaceSecretKey
): Promise<string | undefined> {
  try {
    const pool = getPool();
    const result = await pool.query<{ secret_value: string }>(
      `SELECT secret_value
       FROM workspace_secrets
       WHERE workspace_id = $1
         AND secret_key = $2
         AND (expires_at IS NULL OR expires_at > NOW())
       LIMIT 1`,
      [workspaceId, key]
    );
    return result.rows[0]?.secret_value;
  } catch (err) {
    log.error(`getWorkspaceSecret(${workspaceId}, ${key}) failed:`, (err as Error).message);
    return undefined;
  }
}

/**
 * Upsert a workspace-scoped secret value.
 * @param expiresInDays - optional TTL in days; omit for no expiry
 */
export async function setWorkspaceSecret(
  workspaceId: string,
  key: WorkspaceSecretKey,
  value: string,
  uid: string,
  expiresInDays?: number
): Promise<void> {
  const pool = getPool();
  const expiresAt =
    expiresInDays != null
      ? new Date(Date.now() + expiresInDays * 86_400_000)
      : null;

  await pool.query(
    `INSERT INTO workspace_secrets (workspace_id, secret_key, secret_value, set_by, expires_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (workspace_id, secret_key)
     DO UPDATE SET
       secret_value = EXCLUDED.secret_value,
       set_by       = EXCLUDED.set_by,
       expires_at   = EXCLUDED.expires_at,
       updated_at   = NOW()`,
    [workspaceId, key, value, uid, expiresAt]
  );

  log.active(`Workspace secret set`, `${workspaceId}/${key} by ${uid}`);
}

/**
 * Remove a workspace-scoped secret.
 */
export async function deleteWorkspaceSecret(
  workspaceId: string,
  key: WorkspaceSecretKey
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `DELETE FROM workspace_secrets WHERE workspace_id = $1 AND secret_key = $2`,
    [workspaceId, key]
  );
  log.dim(`Workspace secret deleted: ${workspaceId}/${key}`);
}

/**
 * List secret metadata for a workspace. Does NOT return secret values.
 */
export async function listWorkspaceSecrets(
  workspaceId: string
): Promise<WorkspaceSecretMeta[]> {
  const pool = getPool();
  const result = await pool.query<{
    secret_key: WorkspaceSecretKey;
    set_by: string;
    updated_at: Date;
    expires_at: Date | null;
  }>(
    `SELECT secret_key, set_by, updated_at, expires_at
     FROM workspace_secrets
     WHERE workspace_id = $1
     ORDER BY secret_key`,
    [workspaceId]
  );

  return result.rows.map((row) => ({
    key: row.secret_key,
    setBy: row.set_by,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  }));
}
