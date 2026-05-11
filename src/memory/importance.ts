import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

// ── Content-based Importance Scoring ────────────────────────────────
// Heuristic scoring of a text snippet's importance for save-worthiness.
// Used by post-turn-save to skip low-value memory writes.

export interface ImportanceSignals {
  overall: number;
}

interface ScoreOptions {
  isUserMessage?: boolean;
}

const HIGH_VALUE_SIGNALS = [
  "decided", "important", "critical", "must", "will", "goal",
  "deadline", "always", "never", "key", "priority", "remember",
  "note", "action", "task", "remind",
];

/**
 * Score the importance of a text snippet (0.0–1.0) using heuristics.
 * Higher scores mean the content is more worth saving to memory.
 */
export function scoreImportance(text: string, opts?: ScoreOptions): ImportanceSignals {
  const lower = text.toLowerCase();
  const wordCount = text.split(/\s+/).length;

  let score = 0.0;

  // Length signal: very short sentences are usually low value
  if (wordCount >= 5) score += 0.1;
  if (wordCount >= 10) score += 0.1;

  // High-value keyword signal
  const hitCount = HIGH_VALUE_SIGNALS.filter((s) => lower.includes(s)).length;
  score += Math.min(0.4, hitCount * 0.1);

  // User messages tend to carry intent — slight boost
  if (opts?.isUserMessage) score += 0.1;

  // Questions are generally less important to save than statements
  if (text.trimEnd().endsWith("?")) score -= 0.05;

  return { overall: Math.max(0, Math.min(1, score)) };
}

// ── Ebbinghaus-weighted Memory Importance Scoring ───────────────────
// Implements access-frequency-weighted TTL for memories.
// Frequently accessed memories live longer; rarely accessed ones decay faster.
//
// Ebbinghaus forgetting curve:
//   importance = access_count / (1 + decay_rate * days_since_created)
// High-access memories decay slower; rarely-touched ones are eligible for earlier expiry.

const log = createLogger("memory/importance");

const DECAY_RATE = 0.1; // tunable — higher = faster decay
const RECENCY_DECAY_RATE = 0.05; // rate at which recency bonus fades per day

interface ImportanceRow {
  id: string;
  content: string;
  tier: number;
  score: number;
}

interface DailyNoteRow {
  id: string;
  content: string;
  access_count: number;
  created_at: Date;
  last_accessed_at: Date | null;
}

interface MemoryEntityRow {
  id: string;
  entity_name: string;
  access_count: number;
  created_at: Date;
  last_accessed_at: Date | null;
}

/**
 * Compute importance score (0.0–1.0) from access count and age.
 * Uses the Ebbinghaus forgetting curve formula with a recency bonus.
 */
export function computeImportanceScore(
  accessCount: number,
  createdAt: Date,
  lastAccessedAt: Date | null,
): number {
  const daysSinceCreated = (Date.now() - createdAt.getTime()) / 86_400_000;
  const recencyBonus = lastAccessedAt
    ? Math.exp(-RECENCY_DECAY_RATE * (Date.now() - lastAccessedAt.getTime()) / 86_400_000)
    : 0;
  const rawScore = (accessCount + 1) / (1 + DECAY_RATE * daysSinceCreated) + recencyBonus;
  return Math.min(1.0, rawScore / 10); // normalize to 0–1
}

/**
 * Record a memory access: increments access_count, updates last_accessed_at,
 * and recomputes the importance score in Postgres.
 *
 * tier: 2 = daily_notes, 4 = memory_entities
 */
export async function recordMemoryAccess(
  uid: string,
  memoryId: string,
  tier: 2 | 4,
): Promise<void> {
  const pool = getPool();

  try {
    if (tier === 2) {
      // Fetch current values to compute updated score
      const { rows } = await pool.query<DailyNoteRow>(
        `SELECT id, content, access_count, created_at, last_accessed_at
         FROM daily_notes
         WHERE id = $1 AND uid = $2`,
        [memoryId, uid],
      );

      if (rows.length === 0) return;
      const row = rows[0]!;
      const newAccessCount = row.access_count + 1;
      const newScore = computeImportanceScore(
        newAccessCount,
        new Date(row.created_at),
        null, // about to be set to NOW()
      );

      await pool.query(
        `UPDATE daily_notes
         SET access_count = access_count + 1,
             last_accessed_at = NOW(),
             importance_score = $3
         WHERE id = $1 AND uid = $2`,
        [memoryId, uid, newScore],
      );
    } else {
      // tier === 4: memory_entities
      const { rows } = await pool.query<MemoryEntityRow>(
        `SELECT id, entity_name, access_count, created_at, last_accessed_at
         FROM memory_entities
         WHERE id = $1 AND uid = $2`,
        [memoryId, uid],
      );

      if (rows.length === 0) return;
      const row = rows[0]!;
      const newAccessCount = row.access_count + 1;
      const newScore = computeImportanceScore(
        newAccessCount,
        new Date(row.created_at),
        null,
      );

      await pool.query(
        `UPDATE memory_entities
         SET access_count = access_count + 1,
             last_accessed_at = NOW(),
             importance_score = $3
         WHERE id = $1 AND uid = $2`,
        [memoryId, uid, newScore],
      );
    }
  } catch (err) {
    log.warn(`recordMemoryAccess failed for uid=${uid} memoryId=${memoryId} tier=${tier}: ${String(err)}`);
  }
}

/**
 * Bulk-recompute importance scores for a user's memories.
 * Called by the memory doctor cron to keep scores fresh.
 */
export async function recomputeImportanceScores(uid: string): Promise<{ updated: number }> {
  const pool = getPool();
  let updated = 0;

  // Recompute for daily_notes
  try {
    const { rows: notes } = await pool.query<DailyNoteRow>(
      `SELECT id, content, access_count, created_at, last_accessed_at
       FROM daily_notes
       WHERE uid = $1`,
      [uid],
    );

    for (const row of notes) {
      const score = computeImportanceScore(
        row.access_count,
        new Date(row.created_at),
        row.last_accessed_at ? new Date(row.last_accessed_at) : null,
      );
      await pool.query(
        `UPDATE daily_notes SET importance_score = $1 WHERE id = $2`,
        [score, row.id],
      );
      updated++;
    }
  } catch (err) {
    log.warn(`recomputeImportanceScores daily_notes failed for uid=${uid}: ${String(err)}`);
  }

  // Recompute for memory_entities
  try {
    const { rows: entities } = await pool.query<MemoryEntityRow>(
      `SELECT id, entity_name, access_count, created_at, last_accessed_at
       FROM memory_entities
       WHERE uid = $1`,
      [uid],
    );

    for (const row of entities) {
      const score = computeImportanceScore(
        row.access_count,
        new Date(row.created_at),
        row.last_accessed_at ? new Date(row.last_accessed_at) : null,
      );
      await pool.query(
        `UPDATE memory_entities SET importance_score = $1 WHERE id = $2`,
        [score, row.id],
      );
      updated++;
    }
  } catch (err) {
    log.warn(`recomputeImportanceScores memory_entities failed for uid=${uid}: ${String(err)}`);
  }

  return { updated };
}

/**
 * Return memories sorted by importance descending.
 * Used by prefetch and retrieval ranking.
 */
export async function getTopImportantMemories(
  uid: string,
  limit: number,
): Promise<Array<{ id: string; content: string; tier: number; score: number }>> {
  const pool = getPool();
  const results: ImportanceRow[] = [];

  try {
    const { rows: notes } = await pool.query<{ id: string; content: string; importance_score: number }>(
      `SELECT id, content::text AS content, importance_score
       FROM daily_notes
       WHERE uid = $1
       ORDER BY importance_score DESC
       LIMIT $2`,
      [uid, limit],
    );
    for (const row of notes) {
      results.push({ id: row.id, content: row.content, tier: 2, score: row.importance_score });
    }
  } catch (err) {
    log.warn(`getTopImportantMemories daily_notes failed for uid=${uid}: ${String(err)}`);
  }

  try {
    const { rows: entities } = await pool.query<{ id: string; entity_name: string; importance_score: number }>(
      `SELECT id, entity_name, importance_score
       FROM memory_entities
       WHERE uid = $1
       ORDER BY importance_score DESC
       LIMIT $2`,
      [uid, limit],
    );
    for (const row of entities) {
      results.push({ id: row.id, content: row.entity_name, tier: 4, score: row.importance_score });
    }
  } catch (err) {
    log.warn(`getTopImportantMemories memory_entities failed for uid=${uid}: ${String(err)}`);
  }

  // Sort combined results by score descending and take top limit
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
