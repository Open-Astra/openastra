// ── Agent Credential Vault ─────────────────────────────────────────────
// Per-agent encrypted credentials injected at runtime.
// AES-256-GCM encryption; key from CREDENTIAL_VAULT_KEY env var.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("credential-vault");
const ALGORITHM = "aes-256-gcm";
const KEY_ENV = "CREDENTIAL_VAULT_KEY";

function getVaultKey(): Buffer {
  const raw = process.env[KEY_ENV];
  if (!raw) throw new Error(`${KEY_ENV} not set — credential vault unavailable`);
  const key = Buffer.from(raw, "hex");
  if (key.length !== 32) throw new Error(`${KEY_ENV} must be 32 bytes (64 hex chars)`);
  return key;
}

function encrypt(plaintext: string): { ciphertext: string; iv: string } {
  const key = getVaultKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([encrypted, tag]);
  return { ciphertext: combined.toString("base64"), iv: iv.toString("base64") };
}

function decrypt(ciphertext: string, iv: string): string {
  const key = getVaultKey();
  const combined = Buffer.from(ciphertext, "base64");
  const ivBuf = Buffer.from(iv, "base64");
  const encrypted = combined.subarray(0, combined.length - 16);
  const tag = combined.subarray(combined.length - 16);
  const decipher = createDecipheriv(ALGORITHM, key, ivBuf);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export async function setCredential(
  agentId: string,
  workspaceId: string,
  key: string,
  value: string,
  createdBy?: string,
  description?: string,
): Promise<void> {
  const { ciphertext, iv } = encrypt(value);
  await getPool().query(
    `INSERT INTO agent_credentials
       (id, workspace_id, agent_id, key, ciphertext, iv, description, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (workspace_id, agent_id, key) DO UPDATE
       SET ciphertext = EXCLUDED.ciphertext,
           iv = EXCLUDED.iv,
           description = EXCLUDED.description,
           updated_at = NOW()`,
    [randomUUID(), workspaceId, agentId, key, ciphertext, iv, description ?? null, createdBy ?? null],
  );
  logger.info(`Credential "${key}" stored for agent ${agentId}`);
}

export async function getCredential(
  agentId: string,
  workspaceId: string,
  key: string,
): Promise<string | null> {
  const { rows } = await getPool().query<{ ciphertext: string; iv: string }>(
    `SELECT ciphertext, iv FROM agent_credentials
     WHERE agent_id = $1 AND workspace_id = $2 AND key = $3`,
    [agentId, workspaceId, key],
  );
  if (!rows[0]) return null;
  try {
    return decrypt(rows[0].ciphertext, rows[0].iv);
  } catch {
    logger.error(`Failed to decrypt credential "${key}" for agent ${agentId}`);
    return null;
  }
}

export async function listCredentialKeys(
  agentId: string,
  workspaceId: string,
): Promise<Array<{ key: string; description: string | null; createdAt: Date }>> {
  const { rows } = await getPool().query(
    `SELECT key, description, created_at AS "createdAt"
     FROM agent_credentials WHERE agent_id = $1 AND workspace_id = $2 ORDER BY key`,
    [agentId, workspaceId],
  );
  return rows as Array<{ key: string; description: string | null; createdAt: Date }>;
}

export async function deleteCredential(
  agentId: string,
  workspaceId: string,
  key: string,
): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `DELETE FROM agent_credentials WHERE agent_id = $1 AND workspace_id = $2 AND key = $3`,
    [agentId, workspaceId, key],
  );
  return (rowCount ?? 0) > 0;
}

/** Build an env-var map of all credentials for injection into system prompt or tool context. */
export async function resolveAgentCredentials(
  agentId: string,
  workspaceId: string,
): Promise<Record<string, string>> {
  const { rows } = await getPool().query<{ key: string; ciphertext: string; iv: string }>(
    `SELECT key, ciphertext, iv FROM agent_credentials
     WHERE agent_id = $1 AND workspace_id = $2`,
    [agentId, workspaceId],
  );
  const result: Record<string, string> = {};
  for (const row of rows) {
    try {
      result[row.key] = decrypt(row.ciphertext, row.iv);
    } catch {
      // Skip unreadable entries
    }
  }
  return result;
}
