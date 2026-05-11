// ── Tamper-Proof Audit Ledger ────────────────────────────────────────
// Append-only Merkle hash chain for all agent decisions and tool calls.
// Each entry's hash includes the previous entry's hash, creating an
// unbreakable chain. Periodic Merkle root checkpoints enable fast
// integrity verification for SOC2/HIPAA/FedRAMP audits.

import { createHash } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("audit-ledger");

// ── Types ──────────────────────────────────────────────────────────

export type LedgerEntryType =
  | "agent.decision"
  | "tool.call"
  | "tool.result"
  | "memory.write"
  | "memory.delete"
  | "config.change"
  | "auth.login"
  | "auth.logout"
  | "security.violation";

export interface LedgerEntry {
  sequenceNum: number;
  workspaceId: string;
  entryType: LedgerEntryType;
  agentId: string | null;
  sessionId: string | null;
  uid: string | null;
  payload: Record<string, unknown>;
  entryHash: string;
  prevHash: string;
  merkleRoot: string | null;
  createdAt: Date;
}

export interface LedgerCheckpoint {
  id: string;
  workspaceId: string;
  fromSeq: number;
  toSeq: number;
  merkleRoot: string;
  entryCount: number;
  verifiedAt: Date | null;
  createdAt: Date;
}

export interface VerificationResult {
  valid: boolean;
  entriesChecked: number;
  firstBrokenSeq: number | null;
  details: string;
}

// ── Constants ──────────────────────────────────────────────────────

const GENESIS_HASH = "0".repeat(64); // SHA-256 of nothing
const CHECKPOINT_INTERVAL = 1000;     // Create Merkle checkpoint every N entries

// ── Hash Functions ─────────────────────────────────────────────────

function sha256(data: string): string {
  return createHash("sha256").update(data, "utf-8").digest("hex");
}

function computeEntryHash(sequenceNum: number, prevHash: string, payload: Record<string, unknown>): string {
  const data = `${sequenceNum}|${prevHash}|${JSON.stringify(payload)}`;
  return sha256(data);
}

function computeMerkleRoot(hashes: string[]): string {
  if (hashes.length === 0) return sha256("");
  if (hashes.length === 1) return hashes[0]!;

  const nextLevel: string[] = [];
  for (let i = 0; i < hashes.length; i += 2) {
    const left = hashes[i]!;
    const right = hashes[i + 1] ?? left; // duplicate last if odd
    nextLevel.push(sha256(left + right));
  }
  return computeMerkleRoot(nextLevel);
}

// ── Append ─────────────────────────────────────────────────────────

/**
 * Append an entry to the tamper-proof ledger. The entry's hash includes
 * the previous entry's hash, creating a chain. This is the only way
 * to write to the ledger — no updates or deletes are possible.
 */
export async function appendEntry(
  workspaceId: string,
  entryType: LedgerEntryType,
  payload: Record<string, unknown>,
  options?: {
    agentId?: string;
    sessionId?: string;
    uid?: string;
  },
): Promise<LedgerEntry> {
  const pool = getPool();

  // Get the previous hash (or genesis hash for first entry)
  const { rows: prevRows } = await pool.query(
    `SELECT entry_hash, sequence_num FROM audit_ledger
     WHERE workspace_id = $1 ORDER BY sequence_num DESC LIMIT 1`,
    [workspaceId],
  );
  const prevHash = prevRows.length > 0 ? prevRows[0].entry_hash : GENESIS_HASH;
  const prevSeq = prevRows.length > 0 ? Number(prevRows[0].sequence_num) : 0;

  const nextSeq = prevSeq + 1;
  const entryHash = computeEntryHash(nextSeq, prevHash, payload);

  // Check if we need a Merkle checkpoint
  let merkleRoot: string | null = null;
  if (nextSeq % CHECKPOINT_INTERVAL === 0) {
    merkleRoot = await createCheckpoint(workspaceId, nextSeq - CHECKPOINT_INTERVAL + 1, nextSeq);
  }

  const { rows } = await pool.query(
    `INSERT INTO audit_ledger
       (workspace_id, entry_type, agent_id, session_id, uid, payload, entry_hash, prev_hash, merkle_root)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
     RETURNING *`,
    [
      workspaceId, entryType,
      options?.agentId ?? null,
      options?.sessionId ?? null,
      options?.uid ?? null,
      JSON.stringify(payload),
      entryHash, prevHash, merkleRoot,
    ],
  );

  return mapRow(rows[0]);
}

// ── Verification ───────────────────────────────────────────────────

/**
 * Verify the integrity of the entire hash chain for a workspace.
 * Walks the chain from the beginning and checks that each entry's
 * hash matches the recomputed hash from its data + previous hash.
 */
export async function verifyChain(
  workspaceId: string,
  fromSeq?: number,
  toSeq?: number,
): Promise<VerificationResult> {
  const pool = getPool();

  const conditions = ["workspace_id = $1"];
  const params: unknown[] = [workspaceId];
  let idx = 2;

  if (fromSeq !== undefined) {
    conditions.push(`sequence_num >= $${idx}`);
    params.push(fromSeq);
    idx++;
  }
  if (toSeq !== undefined) {
    conditions.push(`sequence_num <= $${idx}`);
    params.push(toSeq);
    idx++;
  }

  const { rows } = await pool.query(
    `SELECT sequence_num, entry_hash, prev_hash, payload
     FROM audit_ledger WHERE ${conditions.join(" AND ")}
     ORDER BY sequence_num ASC`,
    params,
  );

  if (rows.length === 0) {
    return { valid: true, entriesChecked: 0, firstBrokenSeq: null, details: "No entries to verify" };
  }

  let expectedPrevHash = fromSeq ? rows[0].prev_hash : GENESIS_HASH;
  let checked = 0;

  // If starting from a specific sequence, verify the first entry's prev_hash
  if (fromSeq && fromSeq > 1) {
    const { rows: prev } = await pool.query(
      `SELECT entry_hash FROM audit_ledger WHERE workspace_id = $1 AND sequence_num = $2`,
      [workspaceId, fromSeq - 1],
    );
    if (prev.length > 0) {
      expectedPrevHash = prev[0].entry_hash;
    }
  }

  for (const row of rows) {
    const seq = Number(row.sequence_num);
    checked++;

    // Verify prev_hash linkage
    if (row.prev_hash !== expectedPrevHash) {
      return {
        valid: false,
        entriesChecked: checked,
        firstBrokenSeq: seq,
        details: `Chain broken at seq ${seq}: prev_hash mismatch (expected ${expectedPrevHash.slice(0, 12)}..., got ${row.prev_hash.slice(0, 12)}...)`,
      };
    }

    // Recompute and verify entry hash
    const recomputed = computeEntryHash(seq, row.prev_hash, row.payload);
    if (recomputed !== row.entry_hash) {
      return {
        valid: false,
        entriesChecked: checked,
        firstBrokenSeq: seq,
        details: `Tampered entry at seq ${seq}: hash mismatch (payload may have been modified)`,
      };
    }

    expectedPrevHash = row.entry_hash;
  }

  return {
    valid: true,
    entriesChecked: checked,
    firstBrokenSeq: null,
    details: `All ${checked} entries verified successfully`,
  };
}

// ── Checkpoints ────────────────────────────────────────────────────

async function createCheckpoint(
  workspaceId: string,
  fromSeq: number,
  toSeq: number,
): Promise<string> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT entry_hash FROM audit_ledger
     WHERE workspace_id = $1 AND sequence_num BETWEEN $2 AND $3
     ORDER BY sequence_num ASC`,
    [workspaceId, fromSeq, toSeq],
  );

  const hashes = rows.map((r) => r.entry_hash as string);
  const merkleRoot = computeMerkleRoot(hashes);

  await pool.query(
    `INSERT INTO audit_ledger_checkpoints (workspace_id, from_seq, to_seq, merkle_root, entry_count)
     VALUES ($1, $2, $3, $4, $5)`,
    [workspaceId, fromSeq, toSeq, merkleRoot, hashes.length],
  );

  logger.info(`Created Merkle checkpoint for workspace ${workspaceId}: seq ${fromSeq}-${toSeq}`);
  return merkleRoot;
}

export async function listCheckpoints(workspaceId: string): Promise<LedgerCheckpoint[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM audit_ledger_checkpoints WHERE workspace_id = $1 ORDER BY from_seq DESC`,
    [workspaceId],
  );
  return rows.map(mapCheckpointRow);
}

// ── Queries ────────────────────────────────────────────────────────

export async function getEntries(
  workspaceId: string,
  options?: {
    entryType?: LedgerEntryType;
    agentId?: string;
    sessionId?: string;
    fromSeq?: number;
    limit?: number;
  },
): Promise<LedgerEntry[]> {
  const pool = getPool();
  const conditions = ["workspace_id = $1"];
  const params: unknown[] = [workspaceId];
  let idx = 2;

  if (options?.entryType) { conditions.push(`entry_type = $${idx}`); params.push(options.entryType); idx++; }
  if (options?.agentId) { conditions.push(`agent_id = $${idx}`); params.push(options.agentId); idx++; }
  if (options?.sessionId) { conditions.push(`session_id = $${idx}`); params.push(options.sessionId); idx++; }
  if (options?.fromSeq) { conditions.push(`sequence_num >= $${idx}`); params.push(options.fromSeq); idx++; }

  const limit = options?.limit ?? 100;
  const { rows } = await pool.query(
    `SELECT * FROM audit_ledger WHERE ${conditions.join(" AND ")}
     ORDER BY sequence_num DESC LIMIT $${idx}`,
    [...params, limit],
  );
  return rows.map(mapRow);
}

export async function getLedgerStats(workspaceId: string): Promise<{
  totalEntries: number;
  latestSeq: number;
  latestHash: string;
  checkpointCount: number;
  oldestEntry: Date | null;
  newestEntry: Date | null;
}> {
  const pool = getPool();
  const { rows: stats } = await pool.query(
    `SELECT COUNT(*)::int as total,
            COALESCE(MAX(sequence_num), 0)::int as latest_seq,
            MIN(created_at) as oldest,
            MAX(created_at) as newest
     FROM audit_ledger WHERE workspace_id = $1`,
    [workspaceId],
  );
  const { rows: latest } = await pool.query(
    `SELECT entry_hash FROM audit_ledger WHERE workspace_id = $1 ORDER BY sequence_num DESC LIMIT 1`,
    [workspaceId],
  );
  const { rows: cp } = await pool.query(
    `SELECT COUNT(*)::int as count FROM audit_ledger_checkpoints WHERE workspace_id = $1`,
    [workspaceId],
  );

  return {
    totalEntries: stats[0]?.total ?? 0,
    latestSeq: stats[0]?.latest_seq ?? 0,
    latestHash: latest[0]?.entry_hash ?? GENESIS_HASH,
    checkpointCount: cp[0]?.count ?? 0,
    oldestEntry: stats[0]?.oldest ?? null,
    newestEntry: stats[0]?.newest ?? null,
  };
}

// ── Row Mappers ────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapRow(row: any): LedgerEntry {
  return {
    sequenceNum: Number(row.sequence_num),
    workspaceId: row.workspace_id,
    entryType: row.entry_type,
    agentId: row.agent_id,
    sessionId: row.session_id,
    uid: row.uid,
    payload: row.payload,
    entryHash: row.entry_hash,
    prevHash: row.prev_hash,
    merkleRoot: row.merkle_root,
    createdAt: row.created_at,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapCheckpointRow(row: any): LedgerCheckpoint {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    fromSeq: Number(row.from_seq),
    toSeq: Number(row.to_seq),
    merkleRoot: row.merkle_root,
    entryCount: row.entry_count,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
  };
}
