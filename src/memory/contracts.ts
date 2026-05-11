// ── Memory Contracts ────────────────────────────────────────────────
// Enforceable SLAs per workspace: retention limits, recall latency,
// data residency, and archive policies. Violations are logged and
// optionally enforced (auto-archive, auto-delete).

import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("memory-contracts");

// ── Types ──────────────────────────────────────────────────────────

export interface MemoryContract {
  id: string;
  workspaceId: string;
  name: string;
  maxRetentionDays: number | null;
  minRetentionDays: number | null;
  maxRecallMs: number | null;
  dataResidencyRegion: string | null;
  archivePolicy: "cold_store" | "delete" | "compress";
  tierRestrictions: Record<string, Record<string, unknown>>;
  enforce: boolean;
  lastEnforcedAt: Date | null;
  violationsCount: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContractViolation {
  id: string;
  contractId: string;
  workspaceId: string;
  violationType: "retention_exceeded" | "recall_sla_breach" | "residency_violation";
  details: Record<string, unknown>;
  resolved: boolean;
  createdAt: Date;
}

// ── CRUD ───────────────────────────────────────────────────────────

export async function createContract(
  workspaceId: string,
  name: string,
  options: {
    maxRetentionDays?: number;
    minRetentionDays?: number;
    maxRecallMs?: number;
    dataResidencyRegion?: string;
    archivePolicy?: "cold_store" | "delete" | "compress";
    tierRestrictions?: Record<string, Record<string, unknown>>;
    enforce?: boolean;
  },
  createdBy: string,
): Promise<MemoryContract> {
  const pool = getPool();
  const { rows } = await pool.query<MemoryContract>(
    `INSERT INTO memory_contracts
       (workspace_id, name, max_retention_days, min_retention_days, max_recall_ms,
        data_residency_region, archive_policy, tier_restrictions, enforce, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
     RETURNING *`,
    [
      workspaceId, name,
      options.maxRetentionDays ?? null,
      options.minRetentionDays ?? null,
      options.maxRecallMs ?? null,
      options.dataResidencyRegion ?? null,
      options.archivePolicy ?? "cold_store",
      JSON.stringify(options.tierRestrictions ?? {}),
      options.enforce ?? true,
      createdBy,
    ],
  );
  logger.info(`Created memory contract "${name}" for workspace ${workspaceId}`);
  return mapRow(rows[0]!);
}

export async function getContract(id: string, workspaceId: string): Promise<MemoryContract | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM memory_contracts WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

export async function listContracts(workspaceId: string): Promise<MemoryContract[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM memory_contracts WHERE workspace_id = $1 ORDER BY created_at DESC`,
    [workspaceId],
  );
  return rows.map(mapRow);
}

export async function updateContract(
  id: string,
  workspaceId: string,
  updates: Partial<{
    maxRetentionDays: number | null;
    minRetentionDays: number | null;
    maxRecallMs: number | null;
    dataResidencyRegion: string | null;
    archivePolicy: "cold_store" | "delete" | "compress";
    tierRestrictions: Record<string, Record<string, unknown>>;
    enforce: boolean;
  }>,
): Promise<MemoryContract | null> {
  const pool = getPool();
  const sets: string[] = [];
  const vals: unknown[] = [];
  let idx = 3;

  if (updates.maxRetentionDays !== undefined) { sets.push(`max_retention_days = $${idx}`); vals.push(updates.maxRetentionDays); idx++; }
  if (updates.minRetentionDays !== undefined) { sets.push(`min_retention_days = $${idx}`); vals.push(updates.minRetentionDays); idx++; }
  if (updates.maxRecallMs !== undefined) { sets.push(`max_recall_ms = $${idx}`); vals.push(updates.maxRecallMs); idx++; }
  if (updates.dataResidencyRegion !== undefined) { sets.push(`data_residency_region = $${idx}`); vals.push(updates.dataResidencyRegion); idx++; }
  if (updates.archivePolicy !== undefined) { sets.push(`archive_policy = $${idx}`); vals.push(updates.archivePolicy); idx++; }
  if (updates.tierRestrictions !== undefined) { sets.push(`tier_restrictions = $${idx}::jsonb`); vals.push(JSON.stringify(updates.tierRestrictions)); idx++; }
  if (updates.enforce !== undefined) { sets.push(`enforce = $${idx}`); vals.push(updates.enforce); idx++; }

  if (sets.length === 0) return getContract(id, workspaceId);

  sets.push("updated_at = NOW()");
  const { rows } = await pool.query(
    `UPDATE memory_contracts SET ${sets.join(", ")} WHERE id = $1 AND workspace_id = $2 RETURNING *`,
    [id, workspaceId, ...vals],
  );
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

export async function deleteContract(id: string, workspaceId: string): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    `DELETE FROM memory_contracts WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return (result.rowCount ?? 0) > 0;
}

// ── Enforcement ────────────────────────────────────────────────────

export async function enforceContracts(workspaceId: string): Promise<ContractViolation[]> {
  const pool = getPool();
  const contracts = await listContracts(workspaceId);
  const violations: ContractViolation[] = [];

  for (const contract of contracts) {
    if (!contract.enforce) continue;

    // Check retention violations
    if (contract.maxRetentionDays) {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int as count FROM daily_memory
         WHERE workspace_id IS NOT DISTINCT FROM $1
         AND date < (CURRENT_DATE - INTERVAL '1 day' * $2)
         AND (pinned IS NULL OR pinned = false)`,
        [workspaceId, contract.maxRetentionDays],
      );
      const count = rows[0]?.count ?? 0;
      if (count > 0) {
        const violation = await recordViolation(
          contract.id, workspaceId, "retention_exceeded",
          { memoriesOverLimit: count, maxDays: contract.maxRetentionDays },
        );
        violations.push(violation);

        // Auto-enforce based on archive policy
        if (contract.archivePolicy === "delete") {
          await pool.query(
            `DELETE FROM daily_memory
             WHERE workspace_id IS NOT DISTINCT FROM $1
             AND date < (CURRENT_DATE - INTERVAL '1 day' * $2)
             AND (pinned IS NULL OR pinned = false)`,
            [workspaceId, contract.maxRetentionDays],
          );
          logger.info(`Enforced contract "${contract.name}": deleted ${count} expired memories`);
        }
      }
    }

    // Update enforcement timestamp
    await pool.query(
      `UPDATE memory_contracts SET last_enforced_at = NOW() WHERE id = $1`,
      [contract.id],
    );
  }

  return violations;
}

/**
 * Check if a memory write is allowed by the workspace's contracts.
 * Call this before writing to any memory tier.
 */
export async function checkWriteAllowed(
  workspaceId: string,
  tier: string,
): Promise<{ allowed: boolean; reason?: string }> {
  const contracts = await listContracts(workspaceId);
  for (const contract of contracts) {
    if (!contract.enforce) continue;
    const tierConfig = contract.tierRestrictions[tier] as Record<string, unknown> | undefined;
    if (tierConfig?.disabled === true) {
      return { allowed: false, reason: `Memory tier "${tier}" is disabled by contract "${contract.name}"` };
    }
  }
  return { allowed: true };
}

/**
 * Measure recall latency and check against SLA.
 */
export async function checkRecallSla(
  workspaceId: string,
  actualMs: number,
): Promise<ContractViolation | null> {
  const contracts = await listContracts(workspaceId);
  for (const contract of contracts) {
    if (!contract.enforce || !contract.maxRecallMs) continue;
    if (actualMs > contract.maxRecallMs) {
      return recordViolation(
        contract.id, workspaceId, "recall_sla_breach",
        { actualMs, maxMs: contract.maxRecallMs },
      );
    }
  }
  return null;
}

// ── Violations ─────────────────────────────────────────────────────

async function recordViolation(
  contractId: string,
  workspaceId: string,
  type: ContractViolation["violationType"],
  details: Record<string, unknown>,
): Promise<ContractViolation> {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO memory_contract_violations (contract_id, workspace_id, violation_type, details)
     VALUES ($1, $2, $3, $4::jsonb) RETURNING *`,
    [contractId, workspaceId, type, JSON.stringify(details)],
  );
  await pool.query(
    `UPDATE memory_contracts SET violations_count = violations_count + 1 WHERE id = $1`,
    [contractId],
  );
  logger.warn(`Contract violation: ${type} in workspace ${workspaceId}`);
  return mapViolationRow(rows[0]);
}

export async function listViolations(
  workspaceId: string,
  contractId?: string,
  limit = 50,
): Promise<ContractViolation[]> {
  const pool = getPool();
  const conditions = ["workspace_id = $1"];
  const params: unknown[] = [workspaceId];
  if (contractId) {
    conditions.push(`contract_id = $${params.length + 1}`);
    params.push(contractId);
  }
  const { rows } = await pool.query(
    `SELECT * FROM memory_contract_violations
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC LIMIT $${params.length + 1}`,
    [...params, limit],
  );
  return rows.map(mapViolationRow);
}

// ── Row Mappers ────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapRow(row: any): MemoryContract {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    maxRetentionDays: row.max_retention_days,
    minRetentionDays: row.min_retention_days,
    maxRecallMs: row.max_recall_ms,
    dataResidencyRegion: row.data_residency_region,
    archivePolicy: row.archive_policy,
    tierRestrictions: row.tier_restrictions ?? {},
    enforce: row.enforce,
    lastEnforcedAt: row.last_enforced_at,
    violationsCount: row.violations_count,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapViolationRow(row: any): ContractViolation {
  return {
    id: row.id,
    contractId: row.contract_id,
    workspaceId: row.workspace_id,
    violationType: row.violation_type,
    details: row.details,
    resolved: row.resolved,
    createdAt: row.created_at,
  };
}
