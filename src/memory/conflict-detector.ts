import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("conflict-detector");

// Simple conflict detection: check if new fact contradicts existing facts
// using keyword-based contradiction detection
const CONTRADICTION_PAIRS: [RegExp, RegExp][] = [
  [/\bis\b/i, /\bis not\b|\bisn't\b/i],
  [/\bcan\b/i, /\bcannot\b|\bcan't\b/i],
  [/\bwill\b/i, /\bwill not\b|\bwon't\b/i],
  [/\balways\b/i, /\bnever\b/i],
  [/\byes\b/i, /\bno\b/i],
];

export async function detectConflicts(
  newFact: string,
  uid: string,
  workspaceId: string,
): Promise<void> {
  const pool = getPool();

  // Get recent daily memory entries for this user (search through JSONB array)
  const existing = await pool.query<{ content: string; entry_id: string }>(
    `SELECT
       e->>'content' AS content,
       e->>'timestamp' AS entry_id
     FROM daily_memory,
       jsonb_array_elements(entries) AS e
     WHERE user_id = $1
       AND workspace_id::text = $2
     ORDER BY updated_at DESC
     LIMIT 50`,
    [uid, workspaceId],
  );

  for (const row of existing.rows) {
    const content = row.content ?? "";
    if (!content) continue;

    const isContradiction = CONTRADICTION_PAIRS.some(([patA, patB]) =>
      (patA.test(newFact) && patB.test(content)) ||
      (patB.test(newFact) && patA.test(content)),
    );

    if (isContradiction) {
      const conflictId = randomUUID();
      await pool.query(
        `INSERT INTO memory_conflicts (id, workspace_id, uid, fact_a, fact_b, source_a, source_b)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT DO NOTHING`,
        [conflictId, workspaceId, uid, newFact, content, "new", row.entry_id ?? ""],
      ).catch(() => {}); // ignore duplicates
    }
  }

  log.dim(`Checked ${existing.rows.length} existing facts for conflicts`);
}
