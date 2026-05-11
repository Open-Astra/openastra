import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { scanContent } from "../secrets/scanner.js";
import { createLogger } from "../utils/logger.js";

// ── Cold Store ───────────────────────────────────────────────────────
// Periodic memory snapshots to S3, GCS, or local filesystem.

const log = createLogger("cold-store");

// ── Typed Cold Store Errors ──────────────────────────────────────────

export class ColdStoreReadError extends Error {
  backend: string;
  constructor(backend: string, message: string, cause?: unknown) {
    super(message);
    this.name = "ColdStoreReadError";
    this.backend = backend;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export class ColdStoreWriteError extends Error {
  backend: string;
  constructor(backend: string, message: string, cause?: unknown) {
    super(message);
    this.name = "ColdStoreWriteError";
    this.backend = backend;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export type ColdStoreBackend = "s3" | "gcs" | "local";

export interface ColdStoreConfig {
  backend: ColdStoreBackend;
  bucket: string;
  prefix?: string;
  region?: string;
}

let config: ColdStoreConfig | null = null;
let encryptionKey: Buffer | null = null;

/**
 * Set the encryption key for cold store snapshots.
 * Key must be 32 bytes (passed as 64 hex chars).
 * If not set, snapshots are stored unencrypted (backwards compatible).
 */
export function setColdStoreEncryptionKey(hexKey: string | undefined): void {
  if (!hexKey) {
    log.warn("COLD_STORE_ENCRYPTION_KEY not set — snapshots will NOT be encrypted at rest");
    encryptionKey = null;
    return;
  }
  if (hexKey.length !== 64 || !/^[0-9a-fA-F]+$/.test(hexKey)) {
    throw new Error("COLD_STORE_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)");
  }
  encryptionKey = Buffer.from(hexKey, "hex");
  log.info("Cold store encryption enabled (AES-256-GCM)");
}

/**
 * Encrypt data with AES-256-GCM. Output format: IV (12 bytes) + auth tag (16 bytes) + ciphertext.
 */
function encryptBuffer(plaintext: Buffer): Buffer {
  if (!encryptionKey) return plaintext;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag(); // 16 bytes
  return Buffer.concat([iv, authTag, encrypted]);
}

/**
 * Decrypt AES-256-GCM encrypted data. Input format: IV (12 bytes) + auth tag (16 bytes) + ciphertext.
 */
function decryptBuffer(encrypted: Buffer): Buffer {
  if (!encryptionKey) return encrypted;
  if (encrypted.length < 28) {
    throw new Error("Encrypted data too short — expected at least 28 bytes (IV + auth tag)");
  }
  const iv = encrypted.subarray(0, 12);
  const authTag = encrypted.subarray(12, 28);
  const ciphertext = encrypted.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function initColdStore(cfg: ColdStoreConfig): void {
  config = cfg;
  log.info(`Cold store initialized: backend=${cfg.backend} bucket=${cfg.bucket}`);
}

interface SnapshotResult {
  bytes: number;
  key: string;
}

interface SnapshotPayload {
  snapshotAt: string;
  uid: string | null;
  dailyMemories: unknown[];
  graphEntities: unknown[];
  proceduralMemory: unknown[];
}

/** Deep-clone rows and redact all string values to strip secrets/PII. */
function redactRows(rows: unknown[]): unknown[] {
  return rows.map((row) => {
    if (row === null || typeof row !== "object") return row;
    const cloned: Record<string, unknown> = { ...(row as Record<string, unknown>) };
    for (const key of Object.keys(cloned)) {
      const val = cloned[key];
      if (typeof val === "string") {
        cloned[key] = scanContent(val).sanitized;
      }
    }
    return cloned;
  });
}

export async function snapshotMemory(uid?: string): Promise<SnapshotResult> {
  if (!config) throw new Error("Cold store not initialized");

  const pool = getPool();

  // Query all three memory tiers (optionally filtered by uid)
  const uidFilter = uid ? "WHERE uid = $1" : "";
  const params = uid ? [uid] : [];

  const [dailyResult, graphResult, proceduralResult] = await Promise.all([
    pool.query(`SELECT * FROM daily_memories ${uidFilter}`, params),
    pool.query(`SELECT * FROM graph_entities ${uidFilter}`, params),
    pool.query(`SELECT * FROM procedural_memory ${uidFilter}`, params),
  ]);

  const payload: SnapshotPayload = {
    snapshotAt: new Date().toISOString(),
    uid: uid ?? null,
    dailyMemories: redactRows(dailyResult.rows),
    graphEntities: redactRows(graphResult.rows),
    proceduralMemory: redactRows(proceduralResult.rows),
  };

  const jsonData = JSON.stringify(payload);
  const plainBuffer = Buffer.from(jsonData, "utf-8");
  const uploadBuffer = encryptBuffer(plainBuffer);
  const isEncrypted = encryptionKey !== null;

  const dateStr = new Date().toISOString().slice(0, 10); // "2024-01-15"
  const uidPart = uid ?? "all";
  const ext = isEncrypted ? "json.enc" : "json";
  const keyPart = `snapshots/${dateStr}/memory-${uidPart}-${Date.now()}.${ext}`;
  const key = config.prefix ? `${config.prefix}/${keyPart}` : keyPart;

  log.info(`Uploading snapshot: key=${key} bytes=${uploadBuffer.length} encrypted=${isEncrypted}`);

  try {
    switch (config.backend) {
      case "s3":
        await uploadToS3(config, key, uploadBuffer);
        break;
      case "gcs":
        await uploadToGcs(config, key, uploadBuffer);
        break;
      case "local":
        await uploadToLocal(config, key, uploadBuffer);
        break;
    }
  } catch (err) {
    throw new ColdStoreWriteError(
      config.backend,
      `Failed to write snapshot to ${config.backend}: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  return { bytes: uploadBuffer.length, key };
}

/**
 * Restore and decrypt a snapshot from cold storage.
 * Returns the parsed snapshot payload.
 */
export async function restoreSnapshot(key: string): Promise<SnapshotPayload> {
  if (!config) throw new Error("Cold store not initialized");

  let rawBuffer: Buffer;

  try {
    switch (config.backend) {
      case "s3":
        rawBuffer = await downloadFromS3(config, key);
        break;
      case "gcs":
        rawBuffer = await downloadFromGcs(config, key);
        break;
      case "local":
        rawBuffer = await downloadFromLocal(config, key);
        break;
    }
  } catch (err) {
    throw new ColdStoreReadError(
      config.backend,
      `Failed to read snapshot "${key}" from ${config.backend}: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  const decrypted = decryptBuffer(rawBuffer!);
  return JSON.parse(decrypted.toString("utf-8")) as SnapshotPayload;
}

async function uploadToS3(
  cfg: ColdStoreConfig,
  key: string,
  data: Buffer,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s3Module = await import("@aws-sdk/client-s3" as any) as any;
  const { S3Client, PutObjectCommand } = s3Module;

  const client = new S3Client({ region: cfg.region ?? "us-east-1" });

  await client.send(
    new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: key,
      Body: data,
      ContentType: "application/octet-stream",
    }),
  );
}

async function downloadFromS3(
  cfg: ColdStoreConfig,
  key: string,
): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s3Module = await import("@aws-sdk/client-s3" as any) as any;
  const { S3Client, GetObjectCommand } = s3Module;

  const client = new S3Client({ region: cfg.region ?? "us-east-1" });
  const response = await client.send(
    new GetObjectCommand({ Bucket: cfg.bucket, Key: key }),
  );
  const chunks: Buffer[] = [];
  for await (const chunk of response.Body as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function uploadToGcs(
  cfg: ColdStoreConfig,
  key: string,
  data: Buffer,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gcsModule = await import("@google-cloud/storage" as any) as any;
  const { Storage } = gcsModule;

  const storage = new Storage();
  const bucket = storage.bucket(cfg.bucket);
  const file = bucket.file(key);

  await file.save(data, { contentType: "application/octet-stream" });
}

async function downloadFromGcs(
  cfg: ColdStoreConfig,
  key: string,
): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gcsModule = await import("@google-cloud/storage" as any) as any;
  const { Storage } = gcsModule;

  const storage = new Storage();
  const bucket = storage.bucket(cfg.bucket);
  const file = bucket.file(key);
  const [contents] = await file.download();
  return contents;
}

async function uploadToLocal(
  cfg: ColdStoreConfig,
  key: string,
  data: Buffer,
): Promise<void> {
  const filePath = join(cfg.bucket, key);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, data);
}

async function downloadFromLocal(
  cfg: ColdStoreConfig,
  key: string,
): Promise<Buffer> {
  const filePath = join(cfg.bucket, key);
  return readFile(filePath);
}
