// ── Tamper-Proof Audit Ledger ────────────────────────────────────────
// Append-only hash chain for all agent decisions and tool calls.
// Each entry's hash covers the previous entry's hash plus the entry's
// workspace, chain position, type, actor, session and canonicalised payload.
// Appends are serialised per workspace (advisory lock) and the table rejects
// UPDATE/DELETE/TRUNCATE via triggers (migration 203). Periodic Merkle root checkpoints enable fast
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
  /** Position in this workspace's chain (null for legacy v1 entries). */
  chainSeq?: number | null;
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
  /** Entries written before hash v2 — chain linkage checked, content hash not reproducible. */
  legacyEntries?: number;
  details: string;
}

// ── Constants ──────────────────────────────────────────────────────

const GENESIS_HASH = "0".repeat(64); // SHA-256 of nothing
const CHECKPOINT_INTERVAL = 1000;     // Create Merkle checkpoint every N entries

// ── Hash Functions ─────────────────────────────────────────────────

function sha256(data: string): string {
  return createHash("sha256").update(data, "utf-8").digest("hex");
}

/**
 * Deterministic JSON: object keys sorted recursively. Postgres jsonb does not
 * preserve key order, so the hash must not depend on it.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export interface HashInput {
  workspaceId: string;
  chainSeq: number;
  prevHash: string;
  entryType: string;
  agentId: string | null;
  sessionId: string | null;
  uid: string | null;
  payload: unknown;
}

const HASH_VERSION = 2;

/**
 * v2 entry hash. Covers everything that identifies the event — not just the
 * payload — so the type, actor or session of an entry cannot be rewritten
 * without breaking the chain.
 */
export function computeEntryHash(input: HashInput): string {
  return sha256(canonicalJson({
    v: HASH_VERSION,
    workspaceId: input.workspaceId,
    seq: input.chainSeq,
    prevHash: input.prevHash,
    entryType: input.entryType,
    agentId: input.agentId,
    sessionId: input.sessionId,
    uid: input.uid,
    payload: input.payload,
  }));
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
  // Normalise the payload to what jsonb will hand back (drops undefined,
  // converts Dates etc.) so the stored value and the hashed value are identical.
  const normalizedPayload = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
  const agentId = options?.agentId ?? null;
  const sessionId = options?.sessionId ?? null;
  const uid = options?.uid ?? null;

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Serialise appends per workspace: two concurrent appends would otherwise
    // read the same tail and fork the chain.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('audit_ledger:' || $1, 0))`,
      [workspaceId],
    );

    const { rows: tailRows } = await client.query(
      `SELECT entry_hash FROM audit_ledger
       WHERE workspace_id = $1 ORDER BY sequence_num DESC LIMIT 1`,
      [workspaceId],
    );
    const { rows: posRows } = await client.query(
      `SELECT COALESCE(MAX(chain_seq), COUNT(*))::bigint AS pos
       FROM audit_ledger WHERE workspace_id = $1`,
      [workspaceId],
    );
    const prevHash: string = tailRows.length > 0 ? tailRows[0].entry_hash : GENESIS_HASH;
    const chainSeq = Number(posRows[0]?.pos ?? 0) + 1;

    const entryHash = computeEntryHash({
      workspaceId, chainSeq, prevHash, entryType, agentId, sessionId, uid,
      payload: normalizedPayload,
    });

    // Merkle checkpoint every CHECKPOINT_INTERVAL entries, including this one.
    let merkleRoot: string | null = null;
    if (chainSeq % CHECKPOINT_INTERVAL === 0) {
      const fromSeq = chainSeq - CHECKPOINT_INTERVAL + 1;
      const { rows: hashRows } = await client.query(
        `SELECT entry_hash FROM audit_ledger
         WHERE workspace_id = $1 AND chain_seq BETWEEN $2 AND $3
         ORDER BY chain_seq ASC`,
        [workspaceId, fromSeq, chainSeq - 1],
      );
      const hashes = [...hashRows.map((r) => r.entry_hash as string), entryHash];
      merkleRoot = computeMerkleRoot(hashes);
      await client.query(
        `INSERT INTO audit_ledger_checkpoints (workspace_id, from_seq, to_seq, merkle_root, entry_count)
         VALUES ($1, $2, $3, $4, $5)`,
        [workspaceId, fromSeq, chainSeq, merkleRoot, hashes.length],
      );
      logger.info(`Created Merkle checkpoint for workspace ${workspaceId}: chain seq ${fromSeq}-${chainSeq}`);
    }

    const { rows } = await client.query(
      `INSERT INTO audit_ledger
         (workspace_id, entry_type, agent_id, session_id, uid, payload,
          entry_hash, prev_hash, merkle_root, chain_seq, hash_version)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        workspaceId, entryType, agentId, sessionId, uid,
        JSON.stringify(normalizedPayload),
        entryHash, prevHash, merkleRoot, chainSeq, HASH_VERSION,
      ],
    );

    await client.query("COMMIT");
    return mapRow(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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
    `SELECT sequence_num, chain_seq, hash_version, entry_type, agent_id, session_id, uid,
            entry_hash, prev_hash, payload
     FROM audit_ledger WHERE ${conditions.join(" AND ")}
     ORDER BY sequence_num ASC`,
    params,
  );

  if (rows.length === 0) {
    return { valid: true, entriesChecked: 0, firstBrokenSeq: null, details: "No entries to verify" };
  }

  // The entry before the first one in range (in THIS workspace's chain) —
  // sequence_num is global, so "fromSeq - 1" may belong to another workspace.
  let expectedPrevHash = GENESIS_HASH;
  const firstSeq = Number(rows[0].sequence_num);
  const { rows: prev } = await pool.query(
    `SELECT entry_hash FROM audit_ledger
     WHERE workspace_id = $1 AND sequence_num < $2
     ORDER BY sequence_num DESC LIMIT 1`,
    [workspaceId, firstSeq],
  );
  if (prev.length > 0) expectedPrevHash = prev[0].entry_hash;

  let checked = 0;
  let legacy = 0;
  let expectedChainSeq: number | null = null;

  for (const row of rows) {
    const seq = Number(row.sequence_num);
    checked++;

    // Verify prev_hash linkage
    if (row.prev_hash !== expectedPrevHash) {
      return {
        valid: false,
        entriesChecked: checked,
        firstBrokenSeq: seq,
        details: `Chain broken at seq ${seq}: prev_hash mismatch (expected ${expectedPrevHash.slice(0, 12)}..., got ${String(row.prev_hash).slice(0, 12)}...) — an entry was removed, reordered or forked`,
      };
    }

    if (Number(row.hash_version) >= 2 && row.chain_seq !== null) {
      const chainSeq = Number(row.chain_seq);
      if (expectedChainSeq !== null && chainSeq !== expectedChainSeq) {
        return {
          valid: false,
          entriesChecked: checked,
          firstBrokenSeq: seq,
          details: `Chain gap at seq ${seq}: expected chain position ${expectedChainSeq}, got ${chainSeq}`,
        };
      }
      expectedChainSeq = chainSeq + 1;

      const recomputed = computeEntryHash({
        workspaceId,
        chainSeq,
        prevHash: row.prev_hash,
        entryType: row.entry_type,
        agentId: row.agent_id,
        sessionId: row.session_id,
        uid: row.uid,
        payload: row.payload,
      });
      if (recomputed !== row.entry_hash) {
        return {
          valid: false,
          entriesChecked: checked,
          firstBrokenSeq: seq,
          details: `Tampered entry at seq ${seq}: hash mismatch (entry content was modified)`,
        };
      }
    } else {
      // v1 entries were hashed with a guessed sequence number and
      // order-dependent JSON, so their content hash cannot be reproduced.
      // Their position in the chain (prev_hash linkage) is still verified.
      legacy++;
    }

    expectedPrevHash = row.entry_hash;
  }

  return {
    valid: true,
    entriesChecked: checked,
    firstBrokenSeq: null,
    legacyEntries: legacy,
    details: legacy > 0
      ? `${checked} entries verified (${legacy} legacy v1 entries: linkage verified, content hash not reproducible)`
      : `All ${checked} entries verified successfully`,
  };
}

// ── Checkpoints ────────────────────────────────────────────────────

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
    chainSeq: row.chain_seq !== null && row.chain_seq !== undefined ? Number(row.chain_seq) : null,
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
