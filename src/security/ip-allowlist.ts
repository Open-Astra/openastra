// ── IP Allowlist Per Workspace ────────────────────────────────────────
// Checks whether a client IP is within a workspace's allowed CIDR ranges.
// Supports IPv4 CIDR notation only (e.g., "192.168.1.0/24").
// Returns true if the allowlist is disabled OR the IP is in an allowed range.

import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("ip-allowlist");

// ── CIDR Helpers ──────────────────────────────────────────────────────

/**
 * Convert a dotted-decimal IPv4 address to a 32-bit unsigned integer.
 */
function ipToUint32(ip: string): number {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return (
    ((parts[0]! << 24) |
      (parts[1]! << 16) |
      (parts[2]! << 8) |
      parts[3]!) >>> 0
  );
}

/**
 * Returns true if `ip` falls within the CIDR range.
 * Uses bitwise AND against the network mask for the comparison.
 */
export function isInCidr(ip: string, cidr: string): boolean {
  try {
    const slashIdx = cidr.indexOf("/");
    if (slashIdx === -1) {
      // Treat bare IP as /32
      return ip === cidr;
    }
    const network = cidr.slice(0, slashIdx);
    const prefixLen = parseInt(cidr.slice(slashIdx + 1), 10);
    if (isNaN(prefixLen) || prefixLen < 0 || prefixLen > 32) return false;

    const ipInt = ipToUint32(ip);
    const networkInt = ipToUint32(network);
    const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;

    return (ipInt & mask) === (networkInt & mask);
  } catch {
    return false;
  }
}

// ── DB Row ────────────────────────────────────────────────────────────

interface AllowlistRow {
  allowed_cidrs: string[];
  enabled: boolean;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Check whether `clientIp` is allowed for the given workspace.
 * - If no allowlist row exists → allowed (fail-open for unonfigured workspaces).
 * - If allowlist is disabled → allowed.
 * - If allowed_cidrs is empty → allowed (no restriction configured).
 * - Otherwise, the IP must match at least one CIDR entry.
 */
export async function checkIpAllowlist(
  workspaceId: string,
  clientIp: string,
): Promise<boolean> {
  const pool = getPool();

  const { rows } = await pool.query<AllowlistRow>(
    `SELECT allowed_cidrs, enabled
     FROM workspace_ip_allowlists
     WHERE workspace_id = $1`,
    [workspaceId],
  );

  if (rows.length === 0) return true; // no policy configured

  const row = rows[0]!;
  if (!row.enabled) return true; // allowlist feature disabled
  if (row.allowed_cidrs.length === 0) return true; // no CIDRs = no restriction

  const allowed = row.allowed_cidrs.some((cidr) => isInCidr(clientIp, cidr));

  if (!allowed) {
    log.warn(
      `IP allowlist blocked clientIp=${clientIp} workspaceId=${workspaceId}`,
    );
  }

  return allowed;
}

// ── Config Accessors ──────────────────────────────────────────────────

export interface IpAllowlistConfig {
  workspaceId: string;
  allowedCidrs: string[];
  enabled: boolean;
  updatedAt: string | null;
}

export async function getIpAllowlist(
  workspaceId: string,
): Promise<IpAllowlistConfig> {
  const pool = getPool();
  const { rows } = await pool.query<{
    allowed_cidrs: string[];
    enabled: boolean;
    updated_at: string | null;
  }>(
    `SELECT allowed_cidrs, enabled, updated_at
     FROM workspace_ip_allowlists
     WHERE workspace_id = $1`,
    [workspaceId],
  );

  if (rows.length === 0) {
    return { workspaceId, allowedCidrs: [], enabled: true, updatedAt: null };
  }

  const row = rows[0]!;
  return {
    workspaceId,
    allowedCidrs: row.allowed_cidrs,
    enabled: row.enabled,
    updatedAt: row.updated_at,
  };
}

export async function upsertIpAllowlist(
  workspaceId: string,
  allowedCidrs: string[],
  enabled: boolean,
): Promise<IpAllowlistConfig> {
  const pool = getPool();
  const { rows } = await pool.query<{
    allowed_cidrs: string[];
    enabled: boolean;
    updated_at: string | null;
  }>(
    `INSERT INTO workspace_ip_allowlists (workspace_id, allowed_cidrs, enabled, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (workspace_id) DO UPDATE
       SET allowed_cidrs = EXCLUDED.allowed_cidrs,
           enabled       = EXCLUDED.enabled,
           updated_at    = NOW()
     RETURNING allowed_cidrs, enabled, updated_at`,
    [workspaceId, allowedCidrs, enabled],
  );
  const row = rows[0]!;
  return {
    workspaceId,
    allowedCidrs: row.allowed_cidrs,
    enabled: row.enabled,
    updatedAt: row.updated_at,
  };
}
