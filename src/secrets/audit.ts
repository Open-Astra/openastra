import { createLogger } from "../utils/logger.js";
import { getPool } from "../config/postgres.js";

const log = createLogger("secret-audit");

// ── Secret Audit Log ─────────────────────────────────────────────────
// Records every getSecret() call to secret_audit_log.
// Table is created by migration 023-secrets.sql.
// All writes are fire-and-forget — errors are logged but never thrown.

/**
 * Record a secret READ access to the audit log.
 * Fire-and-forget: never throws.
 */
export async function recordSecretAccess(
  secretName: string,
  backend: string
): Promise<void> {
  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO secret_audit_log (secret_name, backend, process_id, accessed_at)
       VALUES ($1, $2, $3, NOW())`,
      [secretName, backend, process.pid.toString()]
    );
  } catch (err) {
    // Never let audit failures surface — log and continue
    log.error("Failed to record secret access:", (err as Error).message);
  }
}
