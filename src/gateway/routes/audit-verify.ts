import { Router } from "express";
import { createHash } from "node:crypto";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { getPool } from "../../config/postgres.js";

async function verifyHashChain(
  workspaceId: string,
  limit: number = 100,
): Promise<{ valid: boolean; brokenAt?: string; checkedCount: number }> {
  const pool = getPool();
  const { rows } = await pool.query<{
    id: string;
    prev_hash: string | null;
    hash: string | null;
    event: string;
    uid: string;
    metadata: unknown;
    created_at: string;
  }>(
    `SELECT id, prev_hash, hash, event, uid, metadata, created_at
     FROM audit_log
     WHERE workspace_id::text = $1 AND hash IS NOT NULL
     ORDER BY created_at ASC
     LIMIT $2`,
    [workspaceId, limit],
  );

  if (rows.length === 0) return { valid: true, checkedCount: 0 };

  let prevHash = "0000000000000000";
  for (const row of rows) {
    const expectedHash = createHash("sha256")
      .update(prevHash + JSON.stringify({ event: row.event, uid: row.uid, metadata: row.metadata }))
      .digest("hex");

    if (row.hash && row.hash !== expectedHash) {
      return { valid: false, brokenAt: row.id, checkedCount: rows.indexOf(row) + 1 };
    }
    prevHash = row.hash ?? prevHash;
  }

  return { valid: true, checkedCount: rows.length };
}

export function createAuditVerifyRouter(): Router {
  const router = Router();
  const pool = () => getPool();

  router.get("/audit/verify", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    const limit = Math.min(parseInt(String(req.query["limit"] ?? "100"), 10), 10000);
    const result = await verifyHashChain(workspaceId, limit);
    res.json(result);
  });

  router.get("/audit/chain", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    const limit = Math.min(parseInt(String(req.query["limit"] ?? "50"), 10), 500);
    const offset = parseInt(String(req.query["offset"] ?? "0"), 10);

    const { rows } = await pool().query(
      `SELECT id, event, uid, hash, prev_hash, created_at AS "createdAt", metadata
       FROM audit_log
       WHERE workspace_id::text = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [workspaceId, limit, offset],
    );
    res.json({ entries: rows, limit, offset });
  });

  return router;
}
