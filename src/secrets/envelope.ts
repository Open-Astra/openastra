import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// ── Secret Envelope Encryption ───────────────────────────────────────
// AES-256-GCM for secrets stored in Postgres (workspace_secrets).
//
// Stored format (versioned, self-describing):
//   enc:v1:<iv base64>:<auth tag base64>:<ciphertext base64>
//
// - 12-byte random IV per value, 16-byte auth tag.
// - AAD binds the ciphertext to its row (workspace + key name), so a value
//   copied to another tenant's row fails authentication.
// - Key: WORKSPACE_SECRETS_KEY — 64 hex chars or base64 of 32 bytes, or any
//   passphrase ≥ 32 chars (hashed with SHA-256). Read through the secret
//   backend by callers that have one; this module takes the raw key string.
// - WORKSPACE_SECRETS_KEY_PREV: optional previous key for rotation; tried on
//   decrypt only.

export const ENVELOPE_PREFIX = "enc:v1:";
export const WORKSPACE_SECRETS_KEY_ENV = "WORKSPACE_SECRETS_KEY";
export const WORKSPACE_SECRETS_KEY_PREV_ENV = "WORKSPACE_SECRETS_KEY_PREV";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

export class SecretKeyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretKeyUnavailableError";
  }
}

/** Turn a configured key string into 32 key bytes. */
export function deriveKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(trimmed)) {
    const b = Buffer.from(trimmed.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (b.length === 32) return b;
  }
  if (trimmed.length < 32) {
    throw new SecretKeyUnavailableError(
      `${WORKSPACE_SECRETS_KEY_ENV} must be 64 hex chars, base64 of 32 bytes, or a passphrase of at least 32 characters`,
    );
  }
  return createHash("sha256").update(trimmed, "utf8").digest();
}

export function isEnvelope(value: string): boolean {
  return value.startsWith(ENVELOPE_PREFIX);
}

export function encryptSecret(plaintext: string, key: Buffer, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENVELOPE_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

/** Decrypt an envelope. Throws on a malformed envelope, wrong key, or tampering. */
export function decryptSecret(envelope: string, key: Buffer, aad: string): string {
  if (!isEnvelope(envelope)) throw new Error("Not an encrypted secret envelope");
  const parts = envelope.slice(ENVELOPE_PREFIX.length).split(":");
  if (parts.length !== 3) throw new Error("Malformed secret envelope");
  const [ivB64, tagB64, ctB64] = parts as [string, string, string];
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  if (iv.length !== IV_BYTES || tag.length !== 16) throw new Error("Malformed secret envelope");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}
