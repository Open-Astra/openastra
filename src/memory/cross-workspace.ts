import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

// ── Cross-Workspace Memory Sharing ──────────────────────────────────
// Share memory (profiles, daily memory, documents, graph entities)
// between workspaces with granular permission controls.
//
// Sharing model:
//   - Owner: full read/write access to all memory
//   - Shared: read-only access to specific memory segments
//   - Segments: profile, daily_memory, documents, graph, procedures
//
// Use cases:
//   - Team members sharing a knowledge base
//   - Agent teams sharing research across workspaces
//   - Cross-project memory continuity

const log = createLogger("cross-workspace");

// ── Types ───────────────────────────────────────────────────────────

export type MemorySegment = "profile" | "daily_memory" | "documents" | "graph" | "procedures";
export type SharePermission = "read" | "write" | "admin";

export interface MemoryShare {
  id: string;
  ownerUid: string;
  ownerWorkspaceId: string;
  targetUid?: string;          // specific user, or null for workspace-wide
  targetWorkspaceId: string;
  segments: MemorySegment[];
  permission: SharePermission;
  expiresAt?: number;
  createdAt: number;
  revokedAt?: number;
  isActive: boolean;
}

export interface SharedMemoryAccess {
  shareId: string;
  segment: MemorySegment;
  permission: SharePermission;
  ownerUid: string;
  ownerWorkspaceId: string;
}

// ── Create Share ────────────────────────────────────────────────────

/**
 * Share memory segments from one workspace to another.
 */
export async function createMemoryShare(
  ownerUid: string,
  ownerWorkspaceId: string,
  targetWorkspaceId: string,
  segments: MemorySegment[],
  permission: SharePermission = "read",
  options: {
    targetUid?: string;
    expiresInMs?: number;
  } = {},
): Promise<MemoryShare> {
  const pool = getPool();
  const shareId = randomUUID();

  const share: MemoryShare = {
    id: shareId,
    ownerUid,
    ownerWorkspaceId,
    targetUid: options.targetUid,
    targetWorkspaceId,
    segments,
    permission,
    expiresAt: options.expiresInMs ? Date.now() + options.expiresInMs : undefined,
    createdAt: Date.now(),
    isActive: true,
  };

  await pool.query(
    `INSERT INTO memory_shares (id, owner_uid, owner_workspace_id, target_uid, target_workspace_id, segments, permission, config, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, NOW())`,
    [
      shareId,
      ownerUid,
      ownerWorkspaceId,
      options.targetUid ?? null,
      targetWorkspaceId,
      JSON.stringify(segments),
      permission,
      JSON.stringify(share),
      share.expiresAt ? new Date(share.expiresAt).toISOString() : null,
    ],
  );

  log.info(`Memory share created: ${ownerWorkspaceId} → ${targetWorkspaceId} (${segments.join(", ")})`);
  return share;
}

// ── Revoke Share ────────────────────────────────────────────────────

export async function revokeMemoryShare(shareId: string, ownerUid: string): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE memory_shares SET revoked_at = NOW(), config = config || '{"isActive":false}'::jsonb
     WHERE id = $1 AND owner_uid = $2 AND revoked_at IS NULL`,
    [shareId, ownerUid],
  );
  return (result.rowCount ?? 0) > 0;
}

// ── Check Access ────────────────────────────────────────────────────

/**
 * Check if a user has access to a specific memory segment in another workspace.
 */
export async function checkMemoryAccess(
  requestingUid: string,
  requestingWorkspaceId: string,
  targetWorkspaceId: string,
  segment: MemorySegment,
): Promise<SharedMemoryAccess | null> {
  const pool = getPool();

  const { rows } = await pool.query<{
    id: string;
    owner_uid: string;
    owner_workspace_id: string;
    segments: string;
    permission: SharePermission;
  }>(
    `SELECT id, owner_uid, owner_workspace_id, segments, permission
     FROM memory_shares
     WHERE target_workspace_id = $1
       AND (target_uid IS NULL OR target_uid = $2)
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > NOW())
       AND owner_workspace_id = $3`,
    [requestingWorkspaceId, requestingUid, targetWorkspaceId],
  );

  for (const row of rows) {
    const segments = JSON.parse(row.segments) as MemorySegment[];
    if (segments.includes(segment)) {
      return {
        shareId: row.id,
        segment,
        permission: row.permission,
        ownerUid: row.owner_uid,
        ownerWorkspaceId: row.owner_workspace_id,
      };
    }
  }

  return null;
}

// ── List Shares ─────────────────────────────────────────────────────

/**
 * List all active shares owned by a user.
 */
export async function listOwnedShares(ownerUid: string): Promise<MemoryShare[]> {
  const pool = getPool();
  const { rows } = await pool.query<{ config: MemoryShare }>(
    `SELECT config FROM memory_shares
     WHERE owner_uid = $1 AND revoked_at IS NULL
     ORDER BY created_at DESC`,
    [ownerUid],
  );
  return rows.map((r) => r.config);
}

/**
 * List all shares accessible to a user's workspace.
 */
export async function listAccessibleShares(
  uid: string,
  workspaceId: string,
): Promise<MemoryShare[]> {
  const pool = getPool();
  const { rows } = await pool.query<{ config: MemoryShare }>(
    `SELECT config FROM memory_shares
     WHERE target_workspace_id = $1
       AND (target_uid IS NULL OR target_uid = $2)
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY created_at DESC`,
    [workspaceId, uid],
  );
  return rows.map((r) => r.config);
}
