// ── License Key System (XenForo-style) ──────────────────────────────
// Validates license keys against the OpenAstra API on startup, caches
// results locally with a 7-day offline grace period, and tracks
// developer activations (seat counting).
//
// How it works (like XenForo):
//  1. License key entered in astra.yml or ASTRA_LICENSE_KEY env var
//  2. On gateway startup, POST to api.openastra.net/v1/licenses/validate
//  3. Response cached in Postgres (license_cache table)
//  4. If API unreachable, use cached result (7-day grace period)
//  5. Track unique developer UIDs as seat activations
//  6. License status exposed via GET /admin/license

import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { createLogger } from "../utils/logger.js";

const log = createLogger("license");

// ── Types ───────────────────────────────────────────────────────────

export type LicenseTier = "unlicensed" | "solo" | "team";

export interface LicenseInfo {
  valid: boolean;
  tier: LicenseTier;
  customerName?: string;
  customerEmail?: string;
  maxDevelopers: number;
  maxDeployments: number;
  licensedUrl?: string;
  activeDevelopers: number;
  expiresAt?: Date;
  validatedAt: Date;
  graceMode: boolean; // true = using cached result because API is unreachable
}

export interface LicenseValidationResponse {
  valid: boolean;
  tier: LicenseTier;
  customer_name?: string;
  customer_email?: string;
  max_developers: number;
  max_deployments: number;
  licensed_url?: string;
  expires_at?: string;
  error?: string;
}

// ── Constants ───────────────────────────────────────────────────────

const VALIDATION_URL =
  process.env.ASTRA_LICENSE_API_URL ??
  "https://api.openastra.net/v1/licenses/validate";

const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const REVALIDATION_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

const TIER_LIMITS: Record<LicenseTier, { maxDevelopers: number; maxDeployments: number }> = {
  unlicensed: { maxDevelopers: 0, maxDeployments: 0 },
  solo: { maxDevelopers: 1, maxDeployments: 1 },
  team: { maxDevelopers: 5, maxDeployments: Infinity },
};

// ── Singleton State ─────────────────────────────────────────────────

let currentLicense: LicenseInfo = {
  valid: false,
  tier: "unlicensed",
  maxDevelopers: 0,
  maxDeployments: 0,
  activeDevelopers: 0,
  validatedAt: new Date(),
  graceMode: false,
};

let revalidationTimer: ReturnType<typeof setInterval> | null = null;

// ── Installation Fingerprint ────────────────────────────────────────
// XenForo ties licenses to domains; we tie them to a machine+config hash.

let cachedFingerprint: string | null = null;

export function getFingerprint(): string {
  if (cachedFingerprint) return cachedFingerprint;

  const parts = [
    hostname(),
    process.env.ASTRA_SITE_URL ?? process.env.BASE_URL ?? "localhost",
    process.env.PG_DATABASE ?? "astra",
  ];
  cachedFingerprint = createHash("sha256")
    .update(parts.join("|"))
    .digest("hex")
    .slice(0, 16);
  return cachedFingerprint;
}

// ── Remote Validation ───────────────────────────────────────────────

async function validateRemote(
  licenseKey: string,
): Promise<LicenseValidationResponse | null> {
  try {
    const res = await fetch(VALIDATION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        license_key: licenseKey,
        fingerprint: getFingerprint(),
        installation_url:
          process.env.ASTRA_SITE_URL ?? process.env.BASE_URL ?? null,
        version: process.env.npm_package_version ?? "unknown",
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      log.warn(`Validation server returned ${res.status}`);
      return null;
    }

    return (await res.json()) as LicenseValidationResponse;
  } catch (err) {
    log.dim(
      `License server unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// ── DB Cache ────────────────────────────────────────────────────────

async function cacheValidation(
  licenseKey: string,
  response: LicenseValidationResponse,
): Promise<void> {
  try {
    const { getPool } = await import("../config/postgres.js");
    const pool = getPool();
    await pool.query(
      `INSERT INTO license_cache
         (license_key, fingerprint, tier, valid, customer_name, customer_email,
          max_developers, max_deployments, licensed_url, validation_response,
          validated_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), $11)
       ON CONFLICT (license_key, fingerprint)
       DO UPDATE SET
         tier = EXCLUDED.tier,
         valid = EXCLUDED.valid,
         customer_name = EXCLUDED.customer_name,
         customer_email = EXCLUDED.customer_email,
         max_developers = EXCLUDED.max_developers,
         max_deployments = EXCLUDED.max_deployments,
         licensed_url = EXCLUDED.licensed_url,
         validation_response = EXCLUDED.validation_response,
         validated_at = now(),
         expires_at = EXCLUDED.expires_at`,
      [
        licenseKey,
        getFingerprint(),
        response.tier,
        response.valid,
        response.customer_name ?? null,
        response.customer_email ?? null,
        response.max_developers,
        response.max_deployments,
        response.licensed_url ?? null,
        JSON.stringify(response),
        response.expires_at ?? null,
      ],
    );
  } catch {
    // Cache write failure is non-fatal
  }
}

async function loadCachedValidation(
  licenseKey: string,
): Promise<
  | (LicenseValidationResponse & { validated_at: Date })
  | null
> {
  try {
    const { getPool } = await import("../config/postgres.js");
    const pool = getPool();
    const { rows } = await pool.query<{
      tier: string;
      valid: boolean;
      customer_name: string | null;
      customer_email: string | null;
      max_developers: number;
      max_deployments: number;
      licensed_url: string | null;
      validated_at: Date;
      expires_at: Date | null;
    }>(
      `SELECT tier, valid, customer_name, customer_email, max_developers,
              max_deployments, licensed_url, validated_at, expires_at
       FROM license_cache
       WHERE license_key = $1 AND fingerprint = $2
       ORDER BY validated_at DESC LIMIT 1`,
      [licenseKey, getFingerprint()],
    );

    if (rows.length === 0) return null;

    const row = rows[0]!;
    return {
      valid: row.valid,
      tier: row.tier as LicenseTier,
      customer_name: row.customer_name ?? undefined,
      customer_email: row.customer_email ?? undefined,
      max_developers: row.max_developers,
      max_deployments: row.max_deployments,
      licensed_url: row.licensed_url ?? undefined,
      expires_at: row.expires_at?.toISOString(),
      validated_at: row.validated_at,
    };
  } catch {
    return null;
  }
}

// ── Developer Activation Tracking ───────────────────────────────────
// Counts unique developers who've used the system (seat counting).

export async function trackActivation(
  licenseKey: string,
  userId: string,
): Promise<number> {
  try {
    const { getPool } = await import("../config/postgres.js");
    const pool = getPool();
    const fp = getFingerprint();

    // Upsert activation
    await pool.query(
      `INSERT INTO license_activations (license_key, user_id, fingerprint)
       VALUES ($1, $2, $3)
       ON CONFLICT (license_key, user_id, fingerprint)
       DO UPDATE SET last_seen_at = now()`,
      [licenseKey, userId, fp],
    );

    // Count unique developers
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(DISTINCT user_id) AS count
       FROM license_activations
       WHERE license_key = $1 AND fingerprint = $2`,
      [licenseKey, fp],
    );

    return parseInt(rows[0]!.count, 10);
  } catch {
    return 0;
  }
}

// ── License Initialization ──────────────────────────────────────────

export async function initLicense(licenseKey?: string): Promise<LicenseInfo> {
  const key =
    licenseKey ??
    process.env.ASTRA_LICENSE_KEY ??
    undefined;

  if (!key) {
    log.warn("No license key configured — running unlicensed");
    currentLicense = {
      valid: false,
      tier: "unlicensed",
      maxDevelopers: 0,
      maxDeployments: 0,
      activeDevelopers: 0,
      validatedAt: new Date(),
      graceMode: false,
    };
    return currentLicense;
  }

  log.dim(`Validating license ${key.slice(0, 8)}...${key.slice(-4)}`);

  // Try remote validation first
  const remote = await validateRemote(key);

  if (remote) {
    // Remote validation succeeded — cache and use
    await cacheValidation(key, remote);

    currentLicense = {
      valid: remote.valid,
      tier: remote.valid ? remote.tier : "unlicensed",
      customerName: remote.customer_name,
      customerEmail: remote.customer_email,
      maxDevelopers: remote.max_developers ?? TIER_LIMITS[remote.tier]?.maxDevelopers ?? 1,
      maxDeployments: remote.max_deployments ?? TIER_LIMITS[remote.tier]?.maxDeployments ?? 1,
      activeDevelopers: 0,
      expiresAt: remote.expires_at ? new Date(remote.expires_at) : undefined,
      validatedAt: new Date(),
      graceMode: false,
    };

    if (remote.valid) {
      log.active(
        "License",
        `${remote.tier.toUpperCase()} — ${remote.customer_name ?? key.slice(0, 8)}`,
      );
    } else {
      log.warn(`License invalid: ${remote.error ?? "rejected by server"}`);
    }
  } else {
    // Remote unreachable — try cached result
    const cached = await loadCachedValidation(key);

    if (cached && cached.valid) {
      const age = Date.now() - cached.validated_at.getTime();

      if (age < GRACE_PERIOD_MS) {
        // Within grace period — use cached result
        currentLicense = {
          valid: true,
          tier: cached.tier,
          customerName: cached.customer_name,
          customerEmail: cached.customer_email,
          maxDevelopers: cached.max_developers,
          maxDeployments: cached.max_deployments,
          licensedUrl: cached.licensed_url,
          activeDevelopers: 0,
          expiresAt: cached.expires_at
            ? new Date(cached.expires_at)
            : undefined,
          validatedAt: cached.validated_at,
          graceMode: true,
        };

        const graceDaysLeft = Math.ceil(
          (GRACE_PERIOD_MS - age) / (24 * 60 * 60 * 1000),
        );
        log.warn(
          `License server unreachable — using cached validation (${graceDaysLeft}d grace remaining)`,
        );
      } else {
        // Grace period expired
        log.warn(
          "License server unreachable and grace period expired — running unlicensed",
        );
        currentLicense = {
          valid: false,
          tier: "unlicensed",
          maxDevelopers: 0,
          maxDeployments: 0,
          activeDevelopers: 0,
          validatedAt: new Date(),
          graceMode: false,
        };
      }
    } else {
      // No cached result at all
      log.warn(
        "License server unreachable and no cached validation — running unlicensed",
      );
      currentLicense = {
        valid: false,
        tier: "unlicensed",
        maxDevelopers: 0,
        maxDeployments: 0,
        activeDevelopers: 0,
        validatedAt: new Date(),
        graceMode: false,
      };
    }
  }

  // Schedule periodic re-validation (XenForo re-validates on admin access;
  // we re-validate every 24h in the background)
  if (revalidationTimer) clearInterval(revalidationTimer);
  revalidationTimer = setInterval(() => {
    initLicense(key).catch(() => {});
  }, REVALIDATION_INTERVAL_MS);
  // Don't keep the process alive just for re-validation
  if (revalidationTimer.unref) revalidationTimer.unref();

  return currentLicense;
}

// ── Public Getters ──────────────────────────────────────────────────

export function getLicense(): LicenseInfo {
  return { ...currentLicense };
}

export function isLicensed(): boolean {
  return currentLicense.valid;
}

export function getLicenseTier(): LicenseTier {
  return currentLicense.tier;
}

export function stopLicenseRevalidation(): void {
  if (revalidationTimer) {
    clearInterval(revalidationTimer);
    revalidationTimer = null;
  }
}
