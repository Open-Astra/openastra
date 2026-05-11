// ── Memory Federation ──────────────────────────────────────────────────
// Sync memory facts across trusted workspace peers via push/pull.

import { getPool } from "../config/postgres.js";
import { randomUUID } from "node:crypto";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("memory-federation");

export interface FederationNode {
  id: string;
  workspaceId: string;
  peerWorkspaceId: string;
  peerEndpoint: string;
  trustLevel: "read" | "read-write";
  status: "active" | "paused" | "revoked";
  lastSyncAt: Date | null;
  createdAt: Date;
}

export interface FederationSyncLog {
  id: string;
  nodeId: string;
  direction: "push" | "pull";
  recordsSynced: number;
  status: "success" | "partial" | "failed";
  errorMessage: string | null;
  syncedAt: Date;
}

export async function registerFederationNode(
  workspaceId: string,
  peerWorkspaceId: string,
  peerEndpoint: string,
  trustLevel: FederationNode["trustLevel"] = "read",
): Promise<FederationNode> {
  const id = randomUUID();
  const { rows } = await getPool().query<FederationNode>(
    `INSERT INTO federation_nodes
       (id, workspace_id, peer_workspace_id, peer_endpoint, trust_level)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (workspace_id, peer_workspace_id) DO UPDATE
       SET peer_endpoint = EXCLUDED.peer_endpoint,
           trust_level = EXCLUDED.trust_level,
           status = 'active',
           updated_at = NOW()
     RETURNING id, workspace_id AS "workspaceId", peer_workspace_id AS "peerWorkspaceId",
               peer_endpoint AS "peerEndpoint", trust_level AS "trustLevel",
               status, last_sync_at AS "lastSyncAt", created_at AS "createdAt"`,
    [id, workspaceId, peerWorkspaceId, peerEndpoint, trustLevel],
  );
  logger.info(`Federation node registered: ${workspaceId} ↔ ${peerWorkspaceId}`);
  return rows[0]!;
}

export async function listFederationNodes(workspaceId: string): Promise<FederationNode[]> {
  const { rows } = await getPool().query<FederationNode>(
    `SELECT id, workspace_id AS "workspaceId", peer_workspace_id AS "peerWorkspaceId",
            peer_endpoint AS "peerEndpoint", trust_level AS "trustLevel",
            status, last_sync_at AS "lastSyncAt", created_at AS "createdAt"
     FROM federation_nodes WHERE workspace_id = $1 ORDER BY created_at DESC`,
    [workspaceId],
  );
  return rows;
}

export async function getFederationNode(
  id: string,
  workspaceId: string,
): Promise<FederationNode | null> {
  const { rows } = await getPool().query<FederationNode>(
    `SELECT id, workspace_id AS "workspaceId", peer_workspace_id AS "peerWorkspaceId",
            peer_endpoint AS "peerEndpoint", trust_level AS "trustLevel",
            status, last_sync_at AS "lastSyncAt", created_at AS "createdAt"
     FROM federation_nodes WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return rows[0] ?? null;
}

export async function updateNodeStatus(
  id: string,
  workspaceId: string,
  status: FederationNode["status"],
): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE federation_nodes SET status = $3, updated_at = NOW()
     WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId, status],
  );
  return (rowCount ?? 0) > 0;
}

export async function recordSyncLog(
  nodeId: string,
  direction: FederationSyncLog["direction"],
  recordsSynced: number,
  status: FederationSyncLog["status"],
  errorMessage?: string,
): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO federation_sync_log (id, node_id, direction, records_synced, status, error_message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), nodeId, direction, recordsSynced, status, errorMessage ?? null],
    );
    if (status === "success") {
      await getPool().query(
        `UPDATE federation_nodes SET last_sync_at = NOW() WHERE id = $1`,
        [nodeId],
      );
    }
  } catch (err) {
    logger.warn(`Failed to record sync log: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function getSyncHistory(
  nodeId: string,
  workspaceId: string,
  limit = 20,
): Promise<FederationSyncLog[]> {
  const { rows } = await getPool().query<FederationSyncLog>(
    `SELECT fsl.id, fsl.node_id AS "nodeId", fsl.direction,
            fsl.records_synced AS "recordsSynced", fsl.status,
            fsl.error_message AS "errorMessage", fsl.synced_at AS "syncedAt"
     FROM federation_sync_log fsl
     JOIN federation_nodes fn ON fn.id = fsl.node_id
     WHERE fsl.node_id = $1 AND fn.workspace_id = $2
     ORDER BY fsl.synced_at DESC LIMIT $3`,
    [nodeId, workspaceId, limit],
  );
  return rows;
}

logger.info("Memory federation module loaded");
