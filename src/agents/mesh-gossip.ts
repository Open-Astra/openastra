// ── Agent Mesh Gossip ────────────────────────────────────────────────
// Simple gossip protocol for agent mesh discovery.
// Each process registers itself in mesh_nodes, periodically pings peers.
// Peer list is used to route agent requests to the most appropriate node.

import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("mesh-gossip");

/** Stable node ID for this process instance (survives re-registration). */
const NODE_ID = randomUUID();

export interface MeshNode {
  nodeId: string;
  workspaceId: string;
  agentIds: string[];
  host: string;
  port: number;
  lastSeen: Date;
  metadata: Record<string, unknown>;
}

/**
 * Register (or upsert) this process in the mesh_nodes table.
 * Safe to call multiple times — uses INSERT ... ON CONFLICT DO UPDATE.
 */
export async function registerMeshNode(
  workspaceId: string,
  agentIds: string[],
  host: string,
  port: number,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO mesh_nodes (node_id, workspace_id, agent_ids, host, port, last_seen, metadata)
     VALUES ($1, $2, $3, $4, $5, NOW(), $6)
     ON CONFLICT (node_id) DO UPDATE
       SET workspace_id = EXCLUDED.workspace_id,
           agent_ids    = EXCLUDED.agent_ids,
           host         = EXCLUDED.host,
           port         = EXCLUDED.port,
           last_seen    = NOW(),
           metadata     = EXCLUDED.metadata`,
    [NODE_ID, workspaceId, agentIds, host, port, {}],
  );
  log.dim("Registered mesh node", `${NODE_ID} → ${host}:${port}`);
}

/**
 * Update the heartbeat timestamp for this node.
 * Call on a periodic interval (e.g. every 30s) to signal liveness.
 */
export async function updateMeshHeartbeat(workspaceId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE mesh_nodes SET last_seen = NOW()
     WHERE node_id = $1 AND workspace_id = $2`,
    [NODE_ID, workspaceId],
  );
}

/**
 * Return all live peer nodes in the given workspace
 * (excluding this process itself).
 */
export async function getMeshPeers(workspaceId: string): Promise<MeshNode[]> {
  const pool = getPool();
  const result = await pool.query<{
    node_id: string;
    workspace_id: string;
    agent_ids: string[];
    host: string;
    port: number;
    last_seen: Date;
    metadata: Record<string, unknown>;
  }>(
    `SELECT node_id, workspace_id, agent_ids, host, port, last_seen, metadata
     FROM mesh_nodes
     WHERE workspace_id = $1
       AND node_id      != $2
       AND last_seen    > NOW() - INTERVAL '2 minutes'
     ORDER BY last_seen DESC`,
    [workspaceId, NODE_ID],
  );

  return result.rows.map((r) => ({
    nodeId: r.node_id,
    workspaceId: r.workspace_id,
    agentIds: r.agent_ids,
    host: r.host,
    port: r.port,
    lastSeen: r.last_seen,
    metadata: r.metadata,
  }));
}

/**
 * Remove stale nodes that have not sent a heartbeat within the given window.
 * Defaults to 2 minutes (120 000 ms).
 */
export async function pruneStaleMeshNodes(olderThanMs = 120_000): Promise<void> {
  const pool = getPool();
  const intervalSeconds = Math.floor(olderThanMs / 1000);
  const result = await pool.query(
    `DELETE FROM mesh_nodes
     WHERE last_seen < NOW() - INTERVAL '1 second' * $1`,
    [intervalSeconds],
  );
  if ((result.rowCount ?? 0) > 0) {
    log.dim(`Pruned ${result.rowCount} stale mesh node(s)`);
  }
}
