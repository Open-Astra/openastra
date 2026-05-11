import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("cross-agent-memory");

// ── Cross-Agent Memory Sharing ───────────────────────────────────────
// Allows agents to share specific memory entries with other agents,
// with optional expiry. Backed by the shared_memories table.

export interface SharedMemory {
  id: string;
  sourceAgentId: string;
  targetAgentId: string;
  memoryType: string;
  memoryId: string;
  sharedBy: string;
  expiresAt: string | null;
  createdAt: string;
}

/**
 * Share a memory entry from one agent with another.
 */
export async function shareMemory(
  sourceAgentId: string,
  targetAgentId: string,
  memoryType: string,
  memoryId: string,
  sharedBy: string,
  expiresAt?: Date,
): Promise<string> {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO shared_memories (source_agent_id, target_agent_id, memory_type, memory_id, shared_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [sourceAgentId, targetAgentId, memoryType, memoryId, sharedBy, expiresAt ?? null],
  );
  log.info(`Memory shared: ${memoryType}/${memoryId} from ${sourceAgentId} to ${targetAgentId}`);
  return rows[0].id as string;
}

/**
 * Get all memories shared with a target agent, excluding expired ones.
 */
export async function getSharedMemories(
  agentId: string,
): Promise<SharedMemory[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, source_agent_id, target_agent_id, memory_type, memory_id,
            shared_by, expires_at, created_at
     FROM shared_memories
     WHERE target_agent_id = $1
       AND (expires_at IS NULL OR expires_at > now())
     ORDER BY created_at DESC`,
    [agentId],
  );
  return rows.map((r) => ({
    id: r.id,
    sourceAgentId: r.source_agent_id,
    targetAgentId: r.target_agent_id,
    memoryType: r.memory_type,
    memoryId: r.memory_id,
    sharedBy: r.shared_by,
    expiresAt: r.expires_at ? String(r.expires_at) : null,
    createdAt: String(r.created_at),
  }));
}

/**
 * Get all memories shared by a source agent.
 */
export async function getMemoriesSharedBy(
  agentId: string,
): Promise<SharedMemory[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, source_agent_id, target_agent_id, memory_type, memory_id,
            shared_by, expires_at, created_at
     FROM shared_memories
     WHERE source_agent_id = $1
       AND (expires_at IS NULL OR expires_at > now())
     ORDER BY created_at DESC`,
    [agentId],
  );
  return rows.map((r) => ({
    id: r.id,
    sourceAgentId: r.source_agent_id,
    targetAgentId: r.target_agent_id,
    memoryType: r.memory_type,
    memoryId: r.memory_id,
    sharedBy: r.shared_by,
    expiresAt: r.expires_at ? String(r.expires_at) : null,
    createdAt: String(r.created_at),
  }));
}

/**
 * Revoke a shared memory entry. Only the user who shared it can revoke.
 */
export async function revokeSharedMemory(
  id: string,
  uid: string,
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM shared_memories WHERE id = $1 AND shared_by = $2`,
    [id, uid],
  );
  return (rowCount ?? 0) > 0;
}
