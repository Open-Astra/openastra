import { createLogger } from "../utils/logger.js";
import { recordSecretAccess } from "./audit.js";

const log = createLogger("vault");

// ── Secret Backend Types ─────────────────────────────────────────────

export type SecretBackend = "vault" | "aws-asm" | "env";

export interface VaultConfig {
  backend: SecretBackend;
  /** HashiCorp Vault: base URL e.g. http://vault:8200 */
  vaultAddr?: string;
  /** HashiCorp Vault: token for authentication */
  vaultToken?: string;
  /** HashiCorp Vault: KV v2 path e.g. "secret/data/astra" */
  vaultPath?: string;
  /** AWS Secrets Manager: region e.g. "us-east-1" */
  awsRegion?: string;
  /** AWS Secrets Manager: secret name / ARN */
  awsSecretId?: string;
  /** Cache TTL in milliseconds (default: 5 minutes) */
  ttlMs?: number;
}

interface CacheEntry {
  value: string;
  fetchedAt: number;
}

// ── Module-level state ───────────────────────────────────────────────

let cfg: VaultConfig = { backend: "env" };
let ttlMs = 5 * 60 * 1000; // 5 minutes default
const cache = new Map<string, CacheEntry>();

// ── Initialization ───────────────────────────────────────────────────

export function initVault(config: VaultConfig): void {
  cfg = config;
  ttlMs = config.ttlMs ?? 5 * 60 * 1000;
  log.active("Secret backend initialized", config.backend);
}

// ── Cache helpers ────────────────────────────────────────────────────

function isFresh(entry: CacheEntry): boolean {
  return Date.now() - entry.fetchedAt < ttlMs;
}

function cacheAll(secrets: Record<string, string>): void {
  const now = Date.now();
  for (const [k, v] of Object.entries(secrets)) {
    cache.set(k, { value: v, fetchedAt: now });
  }
}

export function invalidateSecret(key: string): void {
  cache.delete(key);
  log.dim(`Cache invalidated for key: ${key}`);
}

// ── HashiCorp Vault KV v2 fetch ───────────────────────────────────────

async function fetchFromVault(): Promise<Record<string, string>> {
  const addr = cfg.vaultAddr ?? process.env.VAULT_ADDR ?? "http://vault:8200";
  const token = cfg.vaultToken ?? process.env.VAULT_TOKEN ?? "";
  const path = cfg.vaultPath ?? process.env.VAULT_PATH ?? "secret/data/astra";

  const url = `${addr}/v1/${path}`;
  const resp = await fetch(url, {
    headers: {
      "X-Vault-Token": token,
      "Content-Type": "application/json",
    },
  });

  if (!resp.ok) {
    throw new Error(`Vault fetch failed: ${resp.status} ${resp.statusText}`);
  }

  const body = (await resp.json()) as { data?: { data?: Record<string, unknown> } };
  const data = body?.data?.data;
  if (!data || typeof data !== "object") {
    throw new Error("Vault response missing data.data field");
  }

  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === "string") result[k] = v;
  }
  return result;
}

// ── AWS Secrets Manager fetch ─────────────────────────────────────────

async function fetchFromAwsAsm(): Promise<Record<string, string>> {
  // Dynamic import — @aws-sdk/client-secrets-manager must be installed at
  // runtime when the aws-asm backend is selected.
  // Use Function constructor to avoid a compile-time TS2307 for the optional dep.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const loader = new Function("m", "return import(m)") as (m: string) => Promise<unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdk: any = await loader("@aws-sdk/client-secrets-manager").catch(() => {
    throw new Error(
      "AWS SDK not found. Install @aws-sdk/client-secrets-manager to use the aws-asm backend."
    );
  });

  const region = cfg.awsRegion ?? process.env.AWS_REGION ?? "us-east-1";
  const secretId = cfg.awsSecretId ?? process.env.AWS_SECRET_ID ?? "astra";

  const client = new sdk.SecretsManagerClient({ region });
  const cmd = new sdk.GetSecretValueCommand({ SecretId: secretId });
  const resp = await client.send(cmd);

  const raw: unknown = resp.SecretString;
  if (typeof raw !== "string" || !raw) {
    throw new Error("AWS ASM response has no SecretString");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AWS ASM SecretString is not valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AWS ASM SecretString must be a JSON object");
  }

  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string") result[k] = v;
  }
  return result;
}

// ── Fetch from configured backend ────────────────────────────────────

async function fetchAll(): Promise<Record<string, string>> {
  switch (cfg.backend) {
    case "vault":
      return fetchFromVault();
    case "aws-asm":
      return fetchFromAwsAsm();
    case "env":
      // env backend returns nothing from fetchAll; getSecret reads directly
      return {};
    default:
      throw new Error(`Unknown secret backend: ${String(cfg.backend)}`);
  }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Retrieve a single secret by key.
 * For Vault/ASM backends: fetches the whole secret blob and caches all keys.
 * For env backend: reads directly from process.env.
 */
export async function getSecret(key: string): Promise<string | undefined> {
  // Check cache first
  const cached = cache.get(key);
  if (cached && isFresh(cached)) {
    await recordSecretAccess(key, cfg.backend);
    return cached.value;
  }

  if (cfg.backend === "env") {
    const value = process.env[key];
    if (value !== undefined) {
      cache.set(key, { value, fetchedAt: Date.now() });
      await recordSecretAccess(key, cfg.backend);
    }
    return value;
  }

  // Fetch entire secret blob from remote backend
  try {
    const all = await fetchAll();
    cacheAll(all);
    const value = all[key];
    if (value !== undefined) {
      await recordSecretAccess(key, cfg.backend);
    }
    return value;
  } catch (err) {
    log.error(`Failed to fetch secrets from backend "${cfg.backend}":`, (err as Error).message);
    // Fall back to process.env
    const fallback = process.env[key];
    if (fallback !== undefined) {
      log.warn(`Using env fallback for key "${key}" after backend error`);
      await recordSecretAccess(key, "env");
    }
    return fallback;
  }
}

/**
 * Warm the cache by pre-fetching all secrets and ensuring the given keys are present.
 * Call at startup after initVault() to avoid cold-start latency.
 */
export async function prefetchSecrets(keys: string[]): Promise<void> {
  if (cfg.backend === "env") {
    for (const key of keys) {
      const value = process.env[key];
      if (value !== undefined) {
        cache.set(key, { value, fetchedAt: Date.now() });
      }
    }
    log.active(`Prefetched ${keys.length} secrets from env`);
    return;
  }

  try {
    const all = await fetchAll();
    cacheAll(all);
    const missing = keys.filter((k) => !(k in all));
    if (missing.length > 0) {
      log.warn(`Prefetch: keys not found in secret backend: ${missing.join(", ")}`);
    }
    log.active(`Prefetched secrets from ${cfg.backend}`, `${Object.keys(all).length} keys cached`);
  } catch (err) {
    log.error("prefetchSecrets failed:", (err as Error).message);
  }
}
