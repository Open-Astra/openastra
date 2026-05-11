// ── CRDT-based Memory Merge ─────────────────────────────────────────
// Conflict-free memory merging across federated workspaces using
// LWW-Element-Set (Last-Writer-Wins) with Lamport vector clocks.
// When workspaces federate, their memories merge deterministically
// without last-write-wins races.

import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("memory-crdt");

// ── Types ──────────────────────────────────────────────────────────

export type VectorClock = Record<string, number>;

export interface CrdtOp {
  id: string;
  workspaceId: string;
  memoryId: string;
  memoryTable: string;
  opType: "add" | "remove" | "update";
  fieldPath: string | null;
  value: unknown;
  vectorClock: VectorClock;
  originWorkspace: string;
  originNode: string | null;
  lamportTs: number;
  createdAt: Date;
}

export interface CrdtState {
  workspaceId: string;
  memoryId: string;
  memoryTable: string;
  fieldPath: string;
  resolvedValue: unknown;
  vectorClock: VectorClock;
  lastOpId: string | null;
  updatedAt: Date;
}

// ── Vector Clock Operations ────────────────────────────────────────

export function incrementClock(clock: VectorClock, nodeId: string): VectorClock {
  return { ...clock, [nodeId]: (clock[nodeId] ?? 0) + 1 };
}

export function mergeClock(a: VectorClock, b: VectorClock): VectorClock {
  const merged: VectorClock = { ...a };
  for (const [key, val] of Object.entries(b)) {
    merged[key] = Math.max(merged[key] ?? 0, val);
  }
  return merged;
}

/**
 * Returns true if clock A causally dominates clock B (A happened after B).
 */
export function dominates(a: VectorClock, b: VectorClock): boolean {
  let strict = false;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const av = a[key] ?? 0;
    const bv = b[key] ?? 0;
    if (av < bv) return false;
    if (av > bv) strict = true;
  }
  return strict;
}

/**
 * Returns true if clocks are concurrent (neither dominates the other).
 */
export function concurrent(a: VectorClock, b: VectorClock): boolean {
  return !dominates(a, b) && !dominates(b, a);
}

// ── Operations ─────────────────────────────────────────────────────

/**
 * Record a CRDT operation. Called whenever a memory entry is written.
 */
export async function recordOp(
  workspaceId: string,
  memoryId: string,
  memoryTable: string,
  opType: "add" | "remove" | "update",
  value: unknown,
  originWorkspace: string,
  options?: {
    fieldPath?: string;
    originNode?: string;
    existingClock?: VectorClock;
  },
): Promise<CrdtOp> {
  const pool = getPool();

  // Get current Lamport timestamp
  const { rows: tsRows } = await pool.query<{ max_ts: string }>(
    `SELECT COALESCE(MAX(lamport_ts), 0)::text as max_ts FROM memory_crdt_ops WHERE workspace_id = $1`,
    [workspaceId],
  );
  const lamportTs = parseInt(tsRows[0]?.max_ts ?? "0", 10) + 1;

  // Build vector clock
  const baseClock = options?.existingClock ?? {};
  const vectorClock = incrementClock(baseClock, originWorkspace);

  const { rows } = await pool.query(
    `INSERT INTO memory_crdt_ops
       (workspace_id, memory_id, memory_table, op_type, field_path, value,
        vector_clock, origin_workspace, origin_node, lamport_ts)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)
     RETURNING *`,
    [
      workspaceId, memoryId, memoryTable, opType,
      options?.fieldPath ?? null,
      JSON.stringify(value),
      JSON.stringify(vectorClock),
      originWorkspace,
      options?.originNode ?? null,
      lamportTs,
    ],
  );

  // Update materialized state
  await resolveState(workspaceId, memoryId, memoryTable, options?.fieldPath ?? "_root");

  return mapOpRow(rows[0]);
}

/**
 * Merge operations from a remote workspace into the local state.
 * This is the core CRDT merge — it applies all remote ops and re-resolves.
 */
export async function mergeRemoteOps(
  localWorkspaceId: string,
  remoteOps: Array<{
    memoryId: string;
    memoryTable: string;
    opType: "add" | "remove" | "update";
    fieldPath?: string;
    value: unknown;
    vectorClock: VectorClock;
    originWorkspace: string;
    originNode?: string;
    lamportTs: number;
  }>,
): Promise<{ merged: number; conflicts: number }> {
  const pool = getPool();
  let merged = 0;
  let conflicts = 0;

  for (const op of remoteOps) {
    // Check if we already have this op (idempotency via vector clock comparison)
    const { rows: existing } = await pool.query(
      `SELECT id FROM memory_crdt_ops
       WHERE workspace_id = $1 AND memory_id = $2 AND memory_table = $3
         AND origin_workspace = $4 AND lamport_ts = $5`,
      [localWorkspaceId, op.memoryId, op.memoryTable, op.originWorkspace, op.lamportTs],
    );
    if (existing.length > 0) continue;

    // Check for concurrent writes (conflict detection)
    const { rows: stateRows } = await pool.query(
      `SELECT vector_clock FROM memory_crdt_state
       WHERE workspace_id = $1 AND memory_id = $2 AND memory_table = $3
         AND field_path = $4`,
      [localWorkspaceId, op.memoryId, op.memoryTable, op.fieldPath ?? "_root"],
    );

    if (stateRows.length > 0) {
      const localClock = stateRows[0].vector_clock as VectorClock;
      if (concurrent(localClock, op.vectorClock)) {
        conflicts++;
        // LWW tiebreak: higher Lamport timestamp wins
        logger.warn(`Concurrent write detected for ${op.memoryId}:${op.fieldPath ?? "_root"}, using LWW tiebreak`);
      }
    }

    // Insert the remote op
    await pool.query(
      `INSERT INTO memory_crdt_ops
         (workspace_id, memory_id, memory_table, op_type, field_path, value,
          vector_clock, origin_workspace, origin_node, lamport_ts)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)`,
      [
        localWorkspaceId, op.memoryId, op.memoryTable, op.opType,
        op.fieldPath ?? null,
        JSON.stringify(op.value),
        JSON.stringify(op.vectorClock),
        op.originWorkspace,
        op.originNode ?? null,
        op.lamportTs,
      ],
    );

    // Re-resolve state
    await resolveState(localWorkspaceId, op.memoryId, op.memoryTable, op.fieldPath ?? "_root");
    merged++;
  }

  logger.info(`Merged ${merged} remote ops (${conflicts} conflicts) into workspace ${localWorkspaceId}`);
  return { merged, conflicts };
}

/**
 * Resolve the current state for a memory field by replaying ops.
 * Uses LWW semantics: the op with the highest Lamport timestamp wins.
 */
async function resolveState(
  workspaceId: string,
  memoryId: string,
  memoryTable: string,
  fieldPath: string,
): Promise<void> {
  const pool = getPool();

  // Get the latest op for this field (LWW: highest Lamport wins)
  const { rows } = await pool.query(
    `SELECT id, value, vector_clock FROM memory_crdt_ops
     WHERE workspace_id = $1 AND memory_id = $2 AND memory_table = $3
       AND (field_path = $4 OR ($4 = '_root' AND field_path IS NULL))
       AND op_type != 'remove'
     ORDER BY lamport_ts DESC LIMIT 1`,
    [workspaceId, memoryId, memoryTable, fieldPath],
  );

  if (rows.length === 0) {
    // All ops are removes — delete state
    await pool.query(
      `DELETE FROM memory_crdt_state
       WHERE workspace_id = $1 AND memory_id = $2 AND memory_table = $3 AND field_path = $4`,
      [workspaceId, memoryId, memoryTable, fieldPath],
    );
    return;
  }

  const winner = rows[0];

  // Merge all vector clocks for this field to get the combined clock
  const { rows: allClocks } = await pool.query(
    `SELECT vector_clock FROM memory_crdt_ops
     WHERE workspace_id = $1 AND memory_id = $2 AND memory_table = $3
       AND (field_path = $4 OR ($4 = '_root' AND field_path IS NULL))`,
    [workspaceId, memoryId, memoryTable, fieldPath],
  );

  let mergedClock: VectorClock = {};
  for (const row of allClocks) {
    mergedClock = mergeClock(mergedClock, row.vector_clock as VectorClock);
  }

  await pool.query(
    `INSERT INTO memory_crdt_state (workspace_id, memory_id, memory_table, field_path, resolved_value, vector_clock, last_op_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
     ON CONFLICT (workspace_id, memory_id, memory_table, field_path) DO UPDATE
     SET resolved_value = $5::jsonb, vector_clock = $6::jsonb, last_op_id = $7, updated_at = NOW()`,
    [workspaceId, memoryId, memoryTable, fieldPath, JSON.stringify(winner.value), JSON.stringify(mergedClock), winner.id],
  );
}

// ── Queries ────────────────────────────────────────────────────────

export async function getState(
  workspaceId: string,
  memoryId: string,
  memoryTable: string,
): Promise<CrdtState[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM memory_crdt_state
     WHERE workspace_id = $1 AND memory_id = $2 AND memory_table = $3`,
    [workspaceId, memoryId, memoryTable],
  );
  return rows.map(mapStateRow);
}

export async function getOpsForMemory(
  workspaceId: string,
  memoryId: string,
  memoryTable: string,
  since?: number,
): Promise<CrdtOp[]> {
  const pool = getPool();
  const conditions = ["workspace_id = $1", "memory_id = $2", "memory_table = $3"];
  const params: unknown[] = [workspaceId, memoryId, memoryTable];
  if (since !== undefined) {
    conditions.push(`lamport_ts > $4`);
    params.push(since);
  }
  const { rows } = await pool.query(
    `SELECT * FROM memory_crdt_ops WHERE ${conditions.join(" AND ")} ORDER BY lamport_ts ASC`,
    params,
  );
  return rows.map(mapOpRow);
}

// ── Row Mappers ────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapOpRow(row: any): CrdtOp {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    memoryId: row.memory_id,
    memoryTable: row.memory_table,
    opType: row.op_type,
    fieldPath: row.field_path,
    value: row.value,
    vectorClock: row.vector_clock,
    originWorkspace: row.origin_workspace,
    originNode: row.origin_node,
    lamportTs: Number(row.lamport_ts),
    createdAt: row.created_at,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapStateRow(row: any): CrdtState {
  return {
    workspaceId: row.workspace_id,
    memoryId: row.memory_id,
    memoryTable: row.memory_table,
    fieldPath: row.field_path,
    resolvedValue: row.resolved_value,
    vectorClock: row.vector_clock,
    lastOpId: row.last_op_id,
    updatedAt: row.updated_at,
  };
}
