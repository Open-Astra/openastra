import { getPool } from "../config/postgres.js";
import { findOrCreateEntity } from "./graph.js";
import type { EntityType } from "./graph.js";

// ── Memory Deduplication ─────────────────────────────────────────────
// Background job that finds near-duplicate memory entries (cosine
// similarity >= 0.92) and consolidates them into graph entities.

interface DedupResult {
  processed: number;
  duplicates: number;
  consolidated: number;
}

interface DuplicatePairRow {
  id_a: string;
  id_b: string;
  content_a: string;
  content_b: string;
  category: string;
  similarity: number;
}

export async function runMemoryDeduplication(uid: string): Promise<DedupResult> {
  const pool = getPool();

  // Step 1: Verify there are recent entries with embeddings
  const { rows: recentRows } = await pool.query<{ id: string }>(
    `SELECT id FROM daily_memories
     WHERE uid = $1 AND embedding IS NOT NULL
       AND created_at > NOW() - INTERVAL '30 days'
     LIMIT 100`,
    [uid],
  );

  const processed = recentRows.length;

  if (processed === 0) {
    return { processed: 0, duplicates: 0, consolidated: 0 };
  }

  // Step 2: Find near-duplicate pairs via self-join cosine similarity
  const { rows: dupRows } = await pool.query<DuplicatePairRow>(
    `SELECT
       a.id AS id_a,
       b.id AS id_b,
       a.content AS content_a,
       b.content AS content_b,
       a.category,
       1 - (a.embedding <=> b.embedding) AS similarity
     FROM daily_memories a
     JOIN daily_memories b
       ON a.uid = b.uid AND a.id < b.id
          AND 1 - (a.embedding <=> b.embedding) >= 0.92
     WHERE a.uid = $1
       AND a.embedding IS NOT NULL
       AND b.embedding IS NOT NULL
     LIMIT 50`,
    [uid],
  );

  const duplicates = dupRows.length;
  let consolidated = 0;

  // Step 3: Consolidate each duplicate pair (avoid processing same id twice)
  const seenIds = new Set<string>();

  for (const row of dupRows) {
    if (seenIds.has(row.id_a) || seenIds.has(row.id_b)) continue;

    seenIds.add(row.id_a);
    seenIds.add(row.id_b);

    try {
      await findOrCreateEntity(
        uid,
        row.category as EntityType,
        "[Consolidated] " + row.content_a.slice(0, 150),
        "deduplicated",
      );
      consolidated++;
    } catch {
      // Catch errors silently — deduplication is best-effort
    }
  }

  return { processed, duplicates, consolidated };
}
