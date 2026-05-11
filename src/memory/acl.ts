// ── Memory ACL ─────────────────────────────────────────────────────────
// Per-entry visibility: private | workspace | cross-workspace.
// Allowed UID list for fine-grained cross-workspace sharing.

import { getPool } from "../config/postgres.js";
import { randomUUID } from "node:crypto";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("memory-acl");

export type MemoryVisibility = "private" | "workspace" | "cross-workspace";

export interface MemoryACL {
  id: string;
  workspaceId: string;
  memoryId: string;
  memoryTable: string;
  visibility: MemoryVisibility;
  allowedUids: string[];
  createdBy: string | null;
  createdAt: Date;
}

export async function setMemoryACL(
  workspaceId: string,
  memoryId: string,
  memoryTable: string,
  visibility: MemoryVisibility,
  allowedUids: string[] = [],
  createdBy?: string,
): Promise<MemoryACL> {
  const id = randomUUID();
  const { rows } = await getPool().query<MemoryACL>(
    `INSERT INTO memory_acl
       (id, workspace_id, memory_id, memory_table, visibility, allowed_uids, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (workspace_id, memory_id, memory_table) DO UPDATE
       SET visibility = EXCLUDED.visibility,
           allowed_uids = EXCLUDED.allowed_uids,
           updated_at = NOW()
     RETURNING id, workspace_id AS "workspaceId", memory_id AS "memoryId",
               memory_table AS "memoryTable", visibility,
               allowed_uids AS "allowedUids", created_by AS "createdBy",
               created_at AS "createdAt"`,
    [id, workspaceId, memoryId, memoryTable, visibility, allowedUids, createdBy ?? null],
  );
  return rows[0]!;
}

export async function getMemoryACL(
  workspaceId: string,
  memoryId: string,
  memoryTable: string,
): Promise<MemoryACL | null> {
  const { rows } = await getPool().query<MemoryACL>(
    `SELECT id, workspace_id AS "workspaceId", memory_id AS "memoryId",
            memory_table AS "memoryTable", visibility,
            allowed_uids AS "allowedUids", created_by AS "createdBy",
            created_at AS "createdAt"
     FROM memory_acl
     WHERE workspace_id = $1 AND memory_id = $2 AND memory_table = $3`,
    [workspaceId, memoryId, memoryTable],
  );
  return rows[0] ?? null;
}

export async function deleteMemoryACL(
  workspaceId: string,
  memoryId: string,
  memoryTable: string,
): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `DELETE FROM memory_acl WHERE workspace_id = $1 AND memory_id = $2 AND memory_table = $3`,
    [workspaceId, memoryId, memoryTable],
  );
  return (rowCount ?? 0) > 0;
}

/** Check if a uid can access a memory entry. */
export async function canAccessMemory(
  requestingWorkspaceId: string,
  requestingUid: string,
  ownerWorkspaceId: string,
  memoryId: string,
  memoryTable: string,
): Promise<boolean> {
  const acl = await getMemoryACL(ownerWorkspaceId, memoryId, memoryTable);

  // No ACL = private by default
  if (!acl) return requestingWorkspaceId === ownerWorkspaceId;

  if (acl.visibility === "private") {
    return requestingWorkspaceId === ownerWorkspaceId &&
      (acl.allowedUids.length === 0 || acl.allowedUids.includes(requestingUid));
  }
  if (acl.visibility === "workspace") {
    return requestingWorkspaceId === ownerWorkspaceId;
  }
  // cross-workspace: uid must be in allowed list
  return acl.allowedUids.includes(requestingUid);
}

export async function listWorkspaceACLs(
  workspaceId: string,
  limit = 50,
): Promise<MemoryACL[]> {
  const { rows } = await getPool().query<MemoryACL>(
    `SELECT id, workspace_id AS "workspaceId", memory_id AS "memoryId",
            memory_table AS "memoryTable", visibility,
            allowed_uids AS "allowedUids", created_by AS "createdBy",
            created_at AS "createdAt"
     FROM memory_acl WHERE workspace_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [workspaceId, limit],
  );
  return rows;
}

logger.info("Memory ACL module loaded");
