import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("memory-expiry");

interface ExpiryRule {
  category: string;
  ttlDays: number;
}

export async function applyExpiryPolicies(workspaceId: string): Promise<void> {
  const pool = getPool();

  const policyResult = await pool.query<{ rules: ExpiryRule[] }>(
    `SELECT rules FROM memory_expiry_policies WHERE workspace_id = $1`,
    [workspaceId],
  );

  if (policyResult.rows.length === 0) return;

  const rules = policyResult.rows[0]!.rules;

  for (const rule of rules) {
    const cutoff = new Date(Date.now() - rule.ttlDays * 24 * 60 * 60 * 1000).toISOString();
    await pool.query(
      `DELETE FROM daily_memory
       WHERE workspace_id::text = $1 AND updated_at < $3
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(entries) AS e
           WHERE (e->>'category') = $2
         )`,
      [workspaceId, rule.category, cutoff],
    ).catch((err: unknown) => {
      log.error(`Expiry error for category ${rule.category}:`, err);
    });
  }
}

export async function applyExpiryPoliciesAllWorkspaces(): Promise<void> {
  const pool = getPool();
  const workspaces = await pool.query<{ workspace_id: string }>(
    `SELECT DISTINCT workspace_id FROM memory_expiry_policies`,
  );

  for (const row of workspaces.rows) {
    await applyExpiryPolicies(row.workspace_id).catch((err: unknown) => {
      log.error(`Expiry for workspace ${row.workspace_id}:`, err);
    });
  }
}
