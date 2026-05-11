import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import type { BlackboardNamespaceConfig } from "./blackboard-acl.js";
import { checkWritePermission, checkReadPermission } from "./blackboard-acl.js";

// ── Shared Blackboard + Debate Protocol ─────────────────────────────
// All agents in a swarm write to a real-time shared blackboard with
// versioning. Conflicting outputs trigger a neutral Mediator agent
// for structured debate rounds until consensus or escalation.
//
// Tables: blackboard_entries, blackboard_conflicts

// ── Types ───────────────────────────────────────────────────────────

export interface BlackboardEntry {
  id: string;
  swarmId: string;
  agentRole: string;         // role that wrote this entry
  agentInstance: string;     // unique instance ID
  section: string;           // logical section (e.g., "research", "analysis")
  content: string;
  version: number;
  previousVersion?: string;  // ID of the entry this replaces
  timestamp: number;
  status: "active" | "superseded" | "disputed";
}

export interface Conflict {
  id: string;
  swarmId: string;
  section: string;
  entries: string[];          // IDs of conflicting entries
  description: string;
  status: "pending" | "debating" | "resolved" | "escalated";
  resolution?: string;
  resolvedBy?: string;       // mediator instance ID
  createdAt: number;
  resolvedAt?: number;
}

export interface DebateRound {
  roundNumber: number;
  arguments: Array<{
    agentRole: string;
    position: string;
    evidence: string;
  }>;
  mediatorVerdict?: string;
  timestamp: number;
}

// ── Blackboard Operations ───────────────────────────────────────────

export async function writeToBlackboard(
  uid: string,
  swarmId: string,
  agentRole: string,
  agentInstance: string,
  section: string,
  content: string,
  aclConfig?: BlackboardNamespaceConfig,
): Promise<BlackboardEntry> {
  // Feature 14: ACL enforcement
  if (aclConfig) {
    const perm = checkWritePermission(aclConfig, section, agentRole);
    if (!perm.allowed) {
      throw new Error(`ACL denied: ${perm.reason}`);
    }
  }

  const pool = getPool();

  // Check for existing active entries in this section
  const { rows: existing } = await pool.query<{
    id: string;
    swarm_id: string;
    key: string;
    value: {
      agentRole: string;
      agentInstance: string;
      section: string;
      content: string;
      version: number;
      previousVersion?: string;
      timestamp: number;
      status: string;
      uid: string;
    };
    written_by: string;
    version: number;
  }>(
    `SELECT id, swarm_id, key, value, written_by, version
     FROM blackboard_entries
     WHERE swarm_id = $1 AND key = $2`,
    [swarmId, `${uid}:${section}`],
  );

  // Filter for active entries
  const activeEntries = existing.filter(
    (r) => r.value.status === "active",
  );

  const entryId = randomUUID();
  const version = activeEntries.length + 1;

  const entry: BlackboardEntry = {
    id: entryId,
    swarmId,
    agentRole,
    agentInstance,
    section,
    content,
    version,
    timestamp: Date.now(),
    status: "active",
  };

  // Check for conflicts with existing entries from different agents
  const conflicting = activeEntries.filter(
    (r) => r.value.agentRole !== agentRole,
  );

  if (conflicting.length > 0) {
    const conflictingEntry: BlackboardEntry = {
      id: conflicting[0]!.id,
      swarmId,
      agentRole: conflicting[0]!.value.agentRole,
      agentInstance: conflicting[0]!.value.agentInstance,
      section: conflicting[0]!.value.section,
      content: conflicting[0]!.value.content,
      version: conflicting[0]!.value.version,
      timestamp: conflicting[0]!.value.timestamp,
      status: conflicting[0]!.value.status as BlackboardEntry["status"],
    };

    const conflict = await detectConflict(
      uid,
      swarmId,
      section,
      entry,
      conflictingEntry,
    );

    if (conflict) {
      entry.status = "disputed";
    }
  }

  // If there's a previous version from the same role, supersede it
  const previousFromSameRole = activeEntries.find(
    (r) => r.value.agentRole === agentRole,
  );
  if (previousFromSameRole) {
    entry.previousVersion = previousFromSameRole.id;
    // Update the previous entry's status to superseded
    const updatedValue = { ...previousFromSameRole.value, status: "superseded" };
    await pool.query(
      "UPDATE blackboard_entries SET value = $1::jsonb, updated_at = NOW() WHERE id = $2",
      [JSON.stringify(updatedValue), previousFromSameRole.id],
    );
  }

  // Insert new entry — use a unique key to allow multiple entries per section
  const entryValue = {
    agentRole,
    agentInstance,
    section,
    content,
    version: entry.version,
    previousVersion: entry.previousVersion ?? null,
    timestamp: entry.timestamp,
    status: entry.status,
    uid,
  };

  await pool.query(
    `INSERT INTO blackboard_entries (id, swarm_id, key, value, written_by, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, NOW(), NOW())
     ON CONFLICT (swarm_id, key)
     DO UPDATE SET value = $4::jsonb, written_by = $5, version = $6, updated_at = NOW()`,
    [
      entryId,
      swarmId,
      `${uid}:${section}:${agentRole}`,
      JSON.stringify(entryValue),
      agentInstance,
      entry.version,
    ],
  );

  return entry;
}

export async function readBlackboard(
  uid: string,
  swarmId: string,
  section?: string,
  aclConfig?: BlackboardNamespaceConfig,
  agentRole?: string,
): Promise<BlackboardEntry[]> {
  const pool = getPool();

  let queryText: string;
  let params: unknown[];

  if (section) {
    queryText = `SELECT id, swarm_id, key, value, written_by, version
                 FROM blackboard_entries
                 WHERE swarm_id = $1 AND key LIKE $2
                 ORDER BY value->>'timestamp' ASC`;
    params = [swarmId, `${uid}:${section}:%`];
  } else {
    queryText = `SELECT id, swarm_id, key, value, written_by, version
                 FROM blackboard_entries
                 WHERE swarm_id = $1 AND key LIKE $2
                 ORDER BY value->>'timestamp' ASC`;
    params = [swarmId, `${uid}:%`];
  }

  const { rows } = await pool.query<{
    id: string;
    swarm_id: string;
    key: string;
    value: {
      agentRole: string;
      agentInstance: string;
      section: string;
      content: string;
      version: number;
      previousVersion?: string;
      timestamp: number;
      status: string;
      uid: string;
    };
    written_by: string;
    version: number;
  }>(queryText, params);

  // Filter for active entries only
  const entries = rows
    .filter((r) => r.value.status === "active")
    .map((r) => ({
      id: r.id,
      swarmId: r.swarm_id,
      agentRole: r.value.agentRole,
      agentInstance: r.value.agentInstance,
      section: r.value.section,
      content: r.value.content,
      version: r.value.version,
      previousVersion: r.value.previousVersion ?? undefined,
      timestamp: r.value.timestamp,
      status: r.value.status as BlackboardEntry["status"],
    }));

  // Feature 14: Filter by read ACL
  if (aclConfig && agentRole) {
    return entries.filter((e) => {
      const perm = checkReadPermission(aclConfig, e.section, agentRole);
      return perm.allowed;
    });
  }

  return entries;
}

export async function getBlackboardSummary(
  uid: string,
  swarmId: string,
): Promise<string> {
  const entries = await readBlackboard(uid, swarmId);

  if (entries.length === 0) return "Blackboard is empty.";

  const sections = new Map<string, BlackboardEntry[]>();
  for (const entry of entries) {
    const list = sections.get(entry.section) ?? [];
    list.push(entry);
    sections.set(entry.section, list);
  }

  const lines: string[] = ["## Blackboard State"];
  for (const [section, sectionEntries] of sections) {
    lines.push(`\n### ${section}`);
    for (const e of sectionEntries) {
      const status = e.status === "disputed" ? " [DISPUTED]" : "";
      lines.push(`[${e.agentRole} v${e.version}]${status}: ${e.content}`);
    }
  }

  return lines.join("\n");
}

// ── Conflict Detection ──────────────────────────────────────────────

async function detectConflict(
  uid: string,
  swarmId: string,
  section: string,
  entry1: BlackboardEntry,
  entry2: BlackboardEntry,
): Promise<Conflict | null> {
  // Simple heuristic: if two different roles write to the same section
  // with substantially different content, flag as conflict
  if (entry1.agentRole === entry2.agentRole) return null;

  // Content similarity check (basic Jaccard on words)
  const words1 = new Set(entry1.content.toLowerCase().split(/\s+/));
  const words2 = new Set(entry2.content.toLowerCase().split(/\s+/));
  const intersection = new Set([...words1].filter((w) => words2.has(w)));
  const union = new Set([...words1, ...words2]);
  const similarity = intersection.size / union.size;

  // If content is very similar (>70%), no conflict
  if (similarity > 0.7) return null;

  // If content is somewhat different (<40% overlap), flag conflict
  if (similarity < 0.4) {
    const pool = getPool();
    const conflictId = randomUUID();

    const conflict: Conflict = {
      id: conflictId,
      swarmId,
      section,
      entries: [entry1.id, entry2.id],
      description: `${entry1.agentRole} and ${entry2.agentRole} disagree on "${section}" (${Math.round(similarity * 100)}% overlap)`,
      status: "pending",
      createdAt: Date.now(),
    };

    // Store in blackboard_conflicts — use entry2's ID as the base entry
    await pool.query(
      `INSERT INTO blackboard_conflicts (id, entry_id, conflicting_value, written_by, resolved, created_at)
       VALUES ($1, $2, $3::jsonb, $4, false, NOW())`,
      [
        conflictId,
        entry2.id,
        JSON.stringify({
          uid,
          swarmId,
          section,
          entries: conflict.entries,
          description: conflict.description,
          status: conflict.status,
        }),
        entry1.agentInstance,
      ],
    );

    console.log(`[blackboard] Conflict detected in swarm ${swarmId}: ${conflict.description}`);
    return conflict;
  }

  return null;
}

// ── Conflict Resolution ─────────────────────────────────────────────

export async function getActiveConflicts(
  _uid: string,
  swarmId: string,
): Promise<Conflict[]> {
  const pool = getPool();

  const { rows } = await pool.query<{
    id: string;
    entry_id: string;
    conflicting_value: {
      uid: string;
      swarmId: string;
      section: string;
      entries: string[];
      description: string;
      status: string;
    };
    written_by: string;
    resolved: boolean;
  }>(
    `SELECT bc.id, bc.entry_id, bc.conflicting_value, bc.written_by, bc.resolved
     FROM blackboard_conflicts bc
     JOIN blackboard_entries be ON be.id = bc.entry_id
     WHERE be.swarm_id = $1 AND bc.resolved = false`,
    [swarmId],
  );

  return rows.map((r) => ({
    id: r.id,
    swarmId: r.conflicting_value.swarmId,
    section: r.conflicting_value.section,
    entries: r.conflicting_value.entries,
    description: r.conflicting_value.description,
    status: r.conflicting_value.status as Conflict["status"],
    createdAt: Date.now(),
  }));
}

export async function resolveConflict(
  _uid: string,
  _swarmId: string,
  conflictId: string,
  resolution: string,
  resolvedBy: string,
): Promise<void> {
  const pool = getPool();

  await pool.query(
    `UPDATE blackboard_conflicts
     SET resolved = true,
         resolved_by = $1,
         conflicting_value = conflicting_value || $2::jsonb
     WHERE id = $3`,
    [
      resolvedBy,
      JSON.stringify({ status: "resolved", resolution }),
      conflictId,
    ],
  );
}

export async function escalateConflict(
  _uid: string,
  _swarmId: string,
  conflictId: string,
): Promise<void> {
  const pool = getPool();

  await pool.query(
    `UPDATE blackboard_conflicts
     SET conflicting_value = conflicting_value || '{"status":"escalated"}'::jsonb
     WHERE id = $1`,
    [conflictId],
  );
}

// ── Clear Blackboard ────────────────────────────────────────────────

export async function clearBlackboard(_uid: string, swarmId: string): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Delete conflicts first (FK dependency on entries)
    await client.query(
      `DELETE FROM blackboard_conflicts
       WHERE entry_id IN (SELECT id FROM blackboard_entries WHERE swarm_id = $1)`,
      [swarmId],
    );

    // Delete entries
    await client.query(
      "DELETE FROM blackboard_entries WHERE swarm_id = $1",
      [swarmId],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ── Persistent Swarm Blackboard (Simple KV) ──────────────────────────
// A simple key-value store for swarm agents backed by swarm_blackboard table.
// Each write emits a "blackboard.updated" event on the event bus so
// watchers can be notified of changes.

import { getEventBus } from "../events/index.js";
import { createLogger } from "../utils/logger.js";

const bbLog = createLogger("swarm-blackboard");

/**
 * Write a value to the swarm blackboard. Uses upsert (ON CONFLICT UPDATE)
 * and increments the version on each write.
 */
export async function blackboardWrite(
  swarmId: string,
  key: string,
  value: unknown,
  agentId: string,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO swarm_blackboard (swarm_id, key, value, written_by, version)
     VALUES ($1, $2, $3, $4, 1)
     ON CONFLICT (swarm_id, key) DO UPDATE
       SET value = $3,
           written_by = $4,
           version = swarm_blackboard.version + 1,
           updated_at = now()`,
    [swarmId, key, JSON.stringify(value), agentId],
  );

  // Emit event for watchers
  try {
    const bus = getEventBus();
    (bus as unknown as { emit(name: string, payload: unknown): void }).emit(
      "blackboard.updated",
      { swarmId, key, value, writtenBy: agentId, timestamp: Date.now() },
    );
  } catch (err) {
    bbLog.warn(`Failed to emit blackboard event: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Read a single key from the swarm blackboard.
 */
export async function blackboardRead(
  swarmId: string,
  key: string,
): Promise<unknown | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT value FROM swarm_blackboard WHERE swarm_id = $1 AND key = $2`,
    [swarmId, key],
  );
  if (rows.length === 0) return null;
  return rows[0].value;
}

/**
 * Read all keys from a swarm's blackboard.
 */
export async function blackboardReadAll(
  swarmId: string,
): Promise<Record<string, unknown>> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT key, value FROM swarm_blackboard WHERE swarm_id = $1`,
    [swarmId],
  );
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

/**
 * Delete a key from the swarm blackboard.
 */
export async function blackboardDelete(
  swarmId: string,
  key: string,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `DELETE FROM swarm_blackboard WHERE swarm_id = $1 AND key = $2`,
    [swarmId, key],
  );
}

/**
 * Watch for changes to a specific blackboard key.
 * Uses the event bus to receive notifications.
 * Returns an unsubscribe function.
 */
export function blackboardWatch(
  swarmId: string,
  key: string,
  callback: (value: unknown) => void,
): () => void {
  const bus = getEventBus();

  const handler = (payload: { swarmId: string; key: string; value: unknown }) => {
    if (payload.swarmId === swarmId && payload.key === key) {
      try {
        callback(payload.value);
      } catch (err) {
        bbLog.warn(`Blackboard watch callback error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  // Access the underlying emitter for untyped events
  const emitter = (bus as unknown as { emitter: { on(event: string, fn: (...args: unknown[]) => void): void; removeListener(event: string, fn: (...args: unknown[]) => void): void } }).emitter;
  emitter.on("blackboard.updated", handler as (...args: unknown[]) => void);

  return () => {
    emitter.removeListener("blackboard.updated", handler as (...args: unknown[]) => void);
  };
}
