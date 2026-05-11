import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("read-through");

interface NoteEntry {
  content: string;
  category: string;
  createdAt: number;
}

interface CacheEntry {
  notes: NoteEntry[];
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000; // 1 minute
const MAX_SIZE = 500;

function makeKey(uid: string, date: string): string {
  return `${uid}:${date}`;
}

/** Read daily notes for uid+date, using in-memory cache with DB fallback. */
export async function readDailyNotes(uid: string, date: string): Promise<NoteEntry[]> {
  const key = makeKey(uid, date);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.notes;

  try {
    const pool = getPool();
    const result = await pool.query<{
      content: string;
      category: string;
      created_at: Date;
    }>(
      `SELECT content, category, created_at
       FROM daily_notes
       WHERE uid = $1 AND date = $2
       ORDER BY created_at ASC`,
      [uid, date],
    );

    const notes: NoteEntry[] = result.rows.map(r => ({
      content: r.content,
      category: r.category,
      createdAt: new Date(r.created_at).getTime(),
    }));

    if (cache.size >= MAX_SIZE) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    cache.set(key, { notes, expiresAt: Date.now() + TTL_MS });
    return notes;
  } catch (err) {
    log.warn(`Read-through cache miss + DB error: ${err instanceof Error ? err.message : String(err)}`);
    return cached?.notes ?? [];
  }
}

/** Invalidate cache entry after a write to daily_notes. */
export function invalidateDailyNotesCache(uid: string, date: string): void {
  cache.delete(makeKey(uid, date));
}

export function getReadThroughCacheStats(): { size: number; maxSize: number } {
  return { size: cache.size, maxSize: MAX_SIZE };
}
