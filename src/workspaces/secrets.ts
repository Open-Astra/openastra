import { createLogger } from "../utils/logger.js";
import { getPool } from "../config/postgres.js";
import { getSecret } from "../secrets/vault.js";
import {
  SecretKeyUnavailableError,
  WORKSPACE_SECRETS_KEY_ENV,
  WORKSPACE_SECRETS_KEY_PREV_ENV,
  decryptSecret,
  deriveKey,
  encryptSecret,
  isEnvelope,
} from "../secrets/envelope.js";

const log = createLogger("workspace-secrets");

// ── Per-Workspace Secret Storage ─────────────────────────────────────
// Tenants can supply their own API keys, overriding platform-level env vars.
// Values are stored in the workspace_secrets table (migration 023),
// encrypted at rest with AES-256-GCM (see secrets/envelope.ts). The key comes
// from WORKSPACE_SECRETS_KEY via the configured secret backend.
// Secret values are NEVER returned by list operations — metadata only.
//
// Legacy rows written before encryption are plaintext; they are still readable
// and are re-encrypted in place the first time they are read with a key
// available (or all at once via reencryptWorkspaceSecrets()).

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

// ── Encryption helpers ────────────────────────────────────────────────

function isProduction(): boolean {
  return process.env.NODE_ENV === "production" || process.env.ASTRA_ENFORCE_SECURITY === "true";
}

async function loadKey(envName: string): Promise<Buffer | undefined> {
  const raw = (await getSecret(envName).catch(() => undefined)) ?? process.env[envName];
  if (!raw) return undefined;
  return deriveKey(raw);
}

function aadFor(workspaceId: string, key: string): string {
  return `workspace_secrets:${workspaceId}:${key}`;
}

let warnedNoKey = false;

/**
 * Encrypt a value for storage in workspace_secrets.secret_value.
 * Fails closed in production when no key is configured. Outside production a
 * missing key stores plaintext with a loud warning so local setups keep working.
 */
export async function sealWorkspaceSecret(
  workspaceId: string,
  key: string,
  value: string,
): Promise<string> {
  const encKey = await loadKey(WORKSPACE_SECRETS_KEY_ENV);
  if (!encKey) {
    if (isProduction()) {
      throw new SecretKeyUnavailableError(
        `${WORKSPACE_SECRETS_KEY_ENV} is not set — refusing to store a workspace secret unencrypted`,
      );
    }
    if (!warnedNoKey) {
      warnedNoKey = true;
      log.warn(`${WORKSPACE_SECRETS_KEY_ENV} is not set — workspace secrets are stored UNENCRYPTED (dev only)`);
    }
    return value;
  }
  return encryptSecret(value, encKey, aadFor(workspaceId, key));
}

/**
 * Decrypt a stored workspace_secrets.secret_value.
 * `legacyPlaintext` is true when the row predates encryption.
 * Throws if the value is encrypted and cannot be decrypted.
 */
export async function openWorkspaceSecret(
  workspaceId: string,
  key: string,
  stored: string,
): Promise<{ value: string; legacyPlaintext: boolean }> {
  if (!isEnvelope(stored)) return { value: stored, legacyPlaintext: true };

  const aad = aadFor(workspaceId, key);
  const current = await loadKey(WORKSPACE_SECRETS_KEY_ENV);
  if (!current) {
    throw new SecretKeyUnavailableError(
      `${WORKSPACE_SECRETS_KEY_ENV} is not set — cannot decrypt workspace secret`,
    );
  }
  try {
    return { value: decryptSecret(stored, current, aad), legacyPlaintext: false };
  } catch (err) {
    const prev = await loadKey(WORKSPACE_SECRETS_KEY_PREV_ENV);
    if (!prev) throw err;
    return { value: decryptSecret(stored, prev, aad), legacyPlaintext: false };
  }
}

/** Best-effort in-place upgrade of a legacy plaintext row. */
async function upgradeLegacyRow(workspaceId: string, key: string, plaintext: string): Promise<void> {
  try {
    const sealed = await sealWorkspaceSecret(workspaceId, key, plaintext);
    if (!isEnvelope(sealed)) return; // no key available
    await getPool().query(
      `UPDATE workspace_secrets SET secret_value = $1
       WHERE workspace_id = $2 AND secret_key = $3 AND secret_value = $4`,
      [sealed, workspaceId, key, plaintext],
    );
  } catch (err) {
    log.warn(`Could not re-encrypt legacy secret ${workspaceId}/${key}: ${(err as Error).message}`);
  }
}

/**
 * Encrypt every remaining plaintext row. Safe to run repeatedly (e.g. at
 * startup); returns the number of rows upgraded.
 */
export async function reencryptWorkspaceSecrets(): Promise<number> {
  const encKey = await loadKey(WORKSPACE_SECRETS_KEY_ENV);
  if (!encKey) return 0;
  const pool = getPool();
  const { rows } = await pool.query<{ workspace_id: string; secret_key: string; secret_value: string }>(
    `SELECT workspace_id, secret_key, secret_value
     FROM workspace_secrets
     WHERE secret_value NOT LIKE 'enc:v1:%'`,
  );
  let upgraded = 0;
  for (const row of rows) {
    const sealed = encryptSecret(row.secret_value, encKey, aadFor(row.workspace_id, row.secret_key));
    const res = await pool.query(
      `UPDATE workspace_secrets SET secret_value = $1
       WHERE workspace_id = $2 AND secret_key = $3 AND secret_value = $4`,
      [sealed, row.workspace_id, row.secret_key, row.secret_value],
    );
    upgraded += res.rowCount ?? 0;
  }
  if (upgraded > 0) log.active(`Re-encrypted ${upgraded} legacy workspace secret(s)`);
  return upgraded;
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
    const stored = result.rows[0]?.secret_value;
    if (stored === undefined) return undefined;
    const opened = await openWorkspaceSecret(workspaceId, key, stored);
    if (opened.legacyPlaintext) void upgradeLegacyRow(workspaceId, key, opened.value);
    return opened.value;
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
  const sealed = await sealWorkspaceSecret(workspaceId, key, value);

  await pool.query(
    `INSERT INTO workspace_secrets (workspace_id, secret_key, secret_value, set_by, expires_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (workspace_id, secret_key)
     DO UPDATE SET
       secret_value = EXCLUDED.secret_value,
       set_by       = EXCLUDED.set_by,
       expires_at   = EXCLUDED.expires_at,
       updated_at   = NOW()`,
    [workspaceId, key, sealed, uid, expiresAt]
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
