// ── Semantic Session Deduplication ──────────────────────────────────
// Detect near-identical sessions and merge them.

import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("session-dedup");

export interface DuplicateSessionGroup {
  sessions: string[];
  similarity: number;
  suggestedPrimary: string;
}

/**
 * Find sessions whose first user messages are near-identical (similarity >= threshold).
 * Uses a simple heuristic: normalise and compare first messages via character overlap.
 * For production use, wire in pgvector cosine similarity if embeddings exist.
 */
export async function findDuplicateSessions(
  workspaceId: string,
  similarityThreshold: number = 0.90,
): Promise<DuplicateSessionGroup[]> {
  const pool = getPool();

  const { rows } = await pool.query<{ id: string; first_message: string }>(
    `SELECT s.id,
            (SELECT content FROM messages m WHERE m.session_id = s.id AND m.role = 'user'
             ORDER BY m.created_at ASC LIMIT 1) AS first_message
     FROM sessions s
     WHERE s.workspace_id = $1 AND s.merged_into IS NULL
     ORDER BY s.created_at DESC
     LIMIT 500`,
    [workspaceId],
  );

  const filtered = rows.filter((r) => r.first_message);
  const groups: DuplicateSessionGroup[] = [];
  const grouped = new Set<string>();

  function similarity(a: string, b: string): number {
    const na = a.toLowerCase().trim();
    const nb = b.toLowerCase().trim();
    if (na === nb) return 1;
    const len = Math.max(na.length, nb.length);
    if (len === 0) return 1;
    let matches = 0;
    const shorter = na.length < nb.length ? na : nb;
    const longer  = na.length < nb.length ? nb : na;
    for (let i = 0; i < shorter.length; i++) {
      if (shorter[i] === longer[i]) matches++;
    }
    return matches / len;
  }

  for (let i = 0; i < filtered.length; i++) {
    if (grouped.has(filtered[i]!.id)) continue;
    const group: string[] = [filtered[i]!.id];

    for (let j = i + 1; j < filtered.length; j++) {
      if (grouped.has(filtered[j]!.id)) continue;
      const sim = similarity(filtered[i]!.first_message, filtered[j]!.first_message);
      if (sim >= similarityThreshold) {
        group.push(filtered[j]!.id);
        grouped.add(filtered[j]!.id);
      }
    }

    if (group.length > 1) {
      grouped.add(filtered[i]!.id);
      groups.push({
        sessions: group,
        similarity: similarityThreshold,
        suggestedPrimary: group[0]!,
      });
    }
  }

  return groups;
}

/**
 * Merge duplicate sessions into a primary session.
 * Moves all messages from duplicates to the primary, then marks duplicates as merged.
 */
export async function mergeSessions(
  primarySessionId: string,
  duplicateSessionIds: string[],
  workspaceId: string,
): Promise<void> {
  const pool = getPool();

  await pool.query("BEGIN");
  try {
    for (const dupId of duplicateSessionIds) {
      // Verify ownership
      const { rows } = await pool.query(
        `SELECT id FROM sessions WHERE id = $1 AND workspace_id = $2 AND merged_into IS NULL`,
        [dupId, workspaceId],
      );
      if (rows.length === 0) continue;

      // Re-parent messages
      await pool.query(
        `UPDATE messages SET session_id = $1 WHERE session_id = $2`,
        [primarySessionId, dupId],
      );

      // Mark as merged
      await pool.query(
        `UPDATE sessions SET merged_into = $1, merged_at = NOW() WHERE id = $2`,
        [primarySessionId, dupId],
      );
    }
    await pool.query("COMMIT");
    logger.info(`Merged ${duplicateSessionIds.length} sessions into ${primarySessionId}`);
  } catch (err) {
    await pool.query("ROLLBACK");
    throw err;
  }
}
