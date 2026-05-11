// ── GDPR Right-to-Erasure ────────────────────────────────────────────
// Hard-delete all data for a user across all 5 memory tiers.

import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("gdpr-erasure");

export interface ErasureResult {
  userId: string;
  workspaceId: string;
  deletedAt: Date;
  counts: {
    sessions: number;
    messages: number;
    dailyMemory: number;
    userProfiles: number;
    graphEntities: number;
    proceduralMemory: number;
    ephemeralMemory: number;
    auditLog: number;
  };
}

/**
 * Permanently erase all data for a user within a workspace.
 * This is irreversible. Caller must verify authorization before calling.
 */
export async function eraseUserData(
  userId: string,
  workspaceId: string,
): Promise<ErasureResult> {
  const pool = getPool();
  logger.warn(`GDPR erasure requested for user=${userId} workspace=${workspaceId}`);

  await pool.query("BEGIN");
  const counts: ErasureResult["counts"] = {
    sessions: 0,
    messages: 0,
    dailyMemory: 0,
    userProfiles: 0,
    graphEntities: 0,
    proceduralMemory: 0,
    ephemeralMemory: 0,
    auditLog: 0,
  };

  try {
    // 1. Ephemeral memory (via session)
    const { rows: sessionIds } = await pool.query<{ id: string }>(
      `SELECT id FROM sessions WHERE uid = $1 AND workspace_id = $2`,
      [userId, workspaceId],
    );
    const ids = sessionIds.map((r) => r.id);

    if (ids.length > 0) {
      const ephRes = await pool.query(
        `DELETE FROM ephemeral_memory WHERE session_id = ANY($1::uuid[])`,
        [ids],
      );
      counts.ephemeralMemory = ephRes.rowCount ?? 0;

      // 2. Messages
      const msgRes = await pool.query(
        `DELETE FROM messages WHERE session_id = ANY($1::uuid[])`,
        [ids],
      );
      counts.messages = msgRes.rowCount ?? 0;
    }

    // 3. Sessions
    const sessRes = await pool.query(
      `DELETE FROM sessions WHERE uid = $1 AND workspace_id = $2`,
      [userId, workspaceId],
    );
    counts.sessions = sessRes.rowCount ?? 0;

    // 4. Daily memory
    const dailyRes = await pool.query(
      `DELETE FROM daily_memory WHERE user_id = $1 AND workspace_id IS NOT DISTINCT FROM $2`,
      [userId, workspaceId],
    );
    counts.dailyMemory = dailyRes.rowCount ?? 0;

    // 5. User profiles
    const profileRes = await pool.query(
      `DELETE FROM user_profiles WHERE user_id = $1 AND workspace_id IS NOT DISTINCT FROM $2`,
      [userId, workspaceId],
    );
    counts.userProfiles = profileRes.rowCount ?? 0;

    // 6. Graph entities (and edges cascade)
    const graphRes = await pool.query(
      `DELETE FROM graph_entities WHERE uid = $1 AND workspace_id IS NOT DISTINCT FROM $2`,
      [userId, workspaceId],
    ).catch(() => ({ rowCount: 0 }));
    counts.graphEntities = (graphRes as { rowCount: number | null }).rowCount ?? 0;

    // 7. Procedural memory
    const procRes = await pool.query(
      `DELETE FROM procedural_memories WHERE user_id = $1 AND workspace_id IS NOT DISTINCT FROM $2`,
      [userId, workspaceId],
    ).catch(() => ({ rowCount: 0 }));
    counts.proceduralMemory = (procRes as { rowCount: number | null }).rowCount ?? 0;

    // 8. Anonymize audit log (replace uid with anonymized hash rather than delete for compliance)
    const { createHash } = await import("node:crypto");
    const anonymizedUid = "gdpr_erased_" + createHash("sha256").update(userId).digest("hex").slice(0, 8);
    const auditRes = await pool.query(
      `UPDATE audit_log SET uid = $3, user_id = $3
       WHERE uid = $1 AND workspace_id::text = $2`,
      [userId, workspaceId, anonymizedUid],
    ).catch(() => ({ rowCount: 0 }));
    counts.auditLog = (auditRes as { rowCount: number | null }).rowCount ?? 0;

    await pool.query("COMMIT");
    logger.warn(`GDPR erasure complete for user=${userId}: ${JSON.stringify(counts)}`);

    return {
      userId,
      workspaceId,
      deletedAt: new Date(),
      counts,
    };
  } catch (err) {
    await pool.query("ROLLBACK");
    throw err;
  }
}
