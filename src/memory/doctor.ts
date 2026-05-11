import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";
import { recomputeImportanceScores } from "./importance.js";

const logger = createLogger("memory/doctor");

// ── Memory Doctor ────────────────────────────────────────────────────
// Periodic maintenance job that canonicalizes and consolidates stale
// daily_notes entries with high cosine similarity (>= 0.92).
//
// Step 1 — Canonicalize: find rows where the same topic appears across
//   multiple dates. Keep the newer row, append the older row's content,
//   delete the older row.
//
// Step 2 — Consolidate: find rows for the same agent_id + category
//   that are > 30 days old and have embeddings within 0.92 cosine distance.
//   Merge them into one row (concatenated content, averaged embedding).

interface DoctorPairRow {
  id_newer: string;
  id_older: string;
  content_newer: string;
  content_older: string;
}

interface ConsolidatePairRow {
  id_a: string;
  id_b: string;
  content_a: string;
  content_b: string;
  agent_id: string;
  category: string;
}

export async function runMemoryDoctor(uid?: string): Promise<{ merged: number; canonicalized: number }> {
  const pool = getPool();
  let canonicalized = 0;
  let merged = 0;

  // ── Step 1: Canonicalize ──────────────────────────────────────────
  // Find daily_notes pairs across different dates with cosine similarity >= 0.92.
  // Keep the newer row, append the older row's content, delete the older row.

  try {
    const { rows: canonPairs } = await pool.query<DoctorPairRow>(
      `SELECT
         CASE WHEN a.created_at >= b.created_at THEN a.id ELSE b.id END AS id_newer,
         CASE WHEN a.created_at >= b.created_at THEN b.id ELSE a.id END AS id_older,
         CASE WHEN a.created_at >= b.created_at THEN a.content ELSE b.content END AS content_newer,
         CASE WHEN a.created_at >= b.created_at THEN b.content ELSE a.content END AS content_older
       FROM daily_notes a
       JOIN daily_notes b
         ON a.id < b.id
            AND a.date::date != b.date::date
            AND 1 - (a.embedding <=> b.embedding) >= 0.92
       WHERE a.embedding IS NOT NULL
         AND b.embedding IS NOT NULL
       LIMIT 100`,
    );

    const seenIds = new Set<string>();

    for (const pair of canonPairs) {
      if (seenIds.has(pair.id_newer) || seenIds.has(pair.id_older)) continue;
      seenIds.add(pair.id_newer);
      seenIds.add(pair.id_older);

      try {
        const mergedContent = `${pair.content_newer}\n\n[Canonicalized from earlier entry]\n${pair.content_older}`;

        await pool.query(
          `UPDATE daily_notes SET content = $1, updated_at = NOW() WHERE id = $2`,
          [mergedContent, pair.id_newer],
        );

        await pool.query(`DELETE FROM daily_notes WHERE id = $1`, [pair.id_older]);

        canonicalized++;
      } catch (err) {
        logger.error(`Canonicalize failed for pair (${pair.id_newer}, ${pair.id_older}):`, err);
      }
    }
  } catch (err) {
    // daily_notes table may not exist — fall through gracefully
    logger.warn("Canonicalize step skipped (table may not exist):", err instanceof Error ? err.message : String(err));
  }

  // ── Step 2: Consolidate ───────────────────────────────────────────
  // Find daily_notes rows for the same agent_id + category that are > 30 days old
  // with embeddings within 0.92 cosine distance. Merge into one row.

  try {
    const { rows: consolidatePairs } = await pool.query<ConsolidatePairRow>(
      `SELECT
         a.id AS id_a,
         b.id AS id_b,
         a.content AS content_a,
         b.content AS content_b,
         a.agent_id,
         a.category
       FROM daily_notes a
       JOIN daily_notes b
         ON a.id < b.id
            AND a.agent_id = b.agent_id
            AND a.category = b.category
            AND 1 - (a.embedding <=> b.embedding) >= 0.92
       WHERE a.embedding IS NOT NULL
         AND b.embedding IS NOT NULL
         AND a.created_at < NOW() - INTERVAL '30 days'
         AND b.created_at < NOW() - INTERVAL '30 days'
       LIMIT 100`,
    );

    const seenConsolidated = new Set<string>();

    for (const pair of consolidatePairs) {
      if (seenConsolidated.has(pair.id_a) || seenConsolidated.has(pair.id_b)) continue;
      seenConsolidated.add(pair.id_a);
      seenConsolidated.add(pair.id_b);

      try {
        const mergedContent = `${pair.content_a}\n\n[Consolidated]\n${pair.content_b}`;

        // Average the two embedding vectors in Postgres
        await pool.query(
          `UPDATE daily_notes
           SET content = $1,
               embedding = (
                 SELECT ((a_emb.embedding::float[] + b_emb.embedding::float[]) / 2.0)::vector
                 FROM (SELECT embedding FROM daily_notes WHERE id = $2) a_emb,
                      (SELECT embedding FROM daily_notes WHERE id = $3) b_emb
               ),
               updated_at = NOW()
           WHERE id = $2`,
          [mergedContent, pair.id_a, pair.id_b],
        );

        await pool.query(`DELETE FROM daily_notes WHERE id = $1`, [pair.id_b]);

        merged++;
      } catch (err) {
        logger.error(`Consolidate failed for pair (${pair.id_a}, ${pair.id_b}):`, err);
      }
    }
  } catch (err) {
    logger.warn("Consolidate step skipped (table may not exist):", err instanceof Error ? err.message : String(err));
  }

  // Record the run in memory_doctor_runs
  try {
    await pool.query(
      `INSERT INTO memory_doctor_runs (merged_count, canonicalized_count)
       VALUES ($1, $2)`,
      [merged, canonicalized],
    );
  } catch (err) {
    logger.warn("Could not insert into memory_doctor_runs:", err instanceof Error ? err.message : String(err));
  }

  // Recompute Ebbinghaus importance scores for the target user (or all users)
  try {
    if (uid) {
      await recomputeImportanceScores(uid);
    } else {
      // Recompute for all distinct users in daily_notes
      const { rows: uidRows } = await pool.query<{ uid: string }>(
        `SELECT DISTINCT uid FROM daily_notes`,
      );
      for (const row of uidRows) {
        await recomputeImportanceScores(row.uid);
      }
    }
  } catch (err) {
    logger.warn("Importance score recompute skipped:", err instanceof Error ? err.message : String(err));
  }

  return { merged, canonicalized };
}
