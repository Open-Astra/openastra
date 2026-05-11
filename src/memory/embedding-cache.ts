import { createHash } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { queueEmbeddingWrite } from "./embedding-batcher.js";
import { createLogger } from "../utils/logger.js";

// ── Embedding Cache ──────────────────────────────────────────────────
// Dual-layer cache: in-process LRU + Postgres persistence.
// Keyed by SHA-256 hash of the input text.
// Writes are coalesced via embedding-batcher (100ms window, max 50/batch).

const log = createLogger("embedding-cache");

const LRU_SIZE = 2048;

// Simple LRU implemented with Map (insertion-order preserved).
// On get: delete + reinsert to move to "most recently used" position.
// On set: evict oldest entry (first key) when at capacity.
const lruCache = new Map<string, number[]>();

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function getCachedEmbedding(text: string): Promise<number[] | null> {
  const hash = hashText(text);

  // Layer 1: in-process LRU
  const cached = lruCache.get(hash);
  if (cached !== undefined) {
    // Move to most-recently-used position
    lruCache.delete(hash);
    lruCache.set(hash, cached);
    return cached;
  }

  // Layer 2: Postgres — throws on query errors, returns null on "no rows"
  const pool = getPool();
  let rows: Array<{ embedding: string }>;
  try {
    const result = await pool.query<{ embedding: string }>(
      "SELECT embedding FROM embedding_cache WHERE text_hash = $1",
      [hash],
    );
    rows = result.rows;
  } catch (err) {
    log.error(
      "Embedding cache read failed:",
      err instanceof Error ? err.message : String(err),
    );
    throw err;
  }

  if (rows.length === 0) return null;

  // Parse pgvector text format "[0.1,0.2,...]" → number[]
  const raw = rows[0]!.embedding;
  const embedding = raw
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map(Number);

  // Populate LRU
  evictIfFull();
  lruCache.set(hash, embedding);

  return embedding;
}

export async function setCachedEmbedding(text: string, embedding: number[]): Promise<void> {
  const hash = hashText(text);

  // Layer 1: set in LRU
  evictIfFull();
  lruCache.set(hash, embedding);

  // Layer 2: Postgres — queue via batcher to coalesce writes within 100ms window
  await queueEmbeddingWrite(hash, embedding);
}

function evictIfFull(): void {
  if (lruCache.size >= LRU_SIZE) {
    // Evict oldest (first inserted) entry
    const oldest = lruCache.keys().next().value;
    if (oldest !== undefined) {
      lruCache.delete(oldest);
    }
  }
}
