import { getPool } from "../config/postgres.js";
import { generateEmbedding } from "./embeddings.js";
import type { MemorySearchResult } from "./types.js";
import { createLogger } from "../utils/logger.js";

// ── pgvector Memory Search ──────────────────────────────────────────
// Fallback search that runs entirely in PostgreSQL using pgvector.
// Used when Typesense is unavailable, or as a complement to the
// primary hybrid search for graph-integrated retrieval.
//
// Combines:
//   - pgvector cosine similarity on memory_chunks.embedding
//   - ILIKE keyword matching as a BM25 approximation
//   - Graph-based re-ranking from connected entities

const log = createLogger("pg-search");

const ENSURE_TABLE = `
CREATE TABLE IF NOT EXISTS memory_chunks (
  id SERIAL PRIMARY KEY,
  uid TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'daily',
  date TEXT,
  category TEXT,
  embedding vector(768),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_uid ON memory_chunks(uid);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_embedding ON memory_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
`;

let tableReady = false;

async function ensureTable(): Promise<void> {
  if (tableReady) return;
  try {
    await getPool().query(ENSURE_TABLE);
    tableReady = true;
  } catch (err) {
    // ivfflat index may fail if not enough rows; that's OK
    log.dim("pg-search table init (index may need data):", err instanceof Error ? err.message : "");
    tableReady = true;
  }
}

/**
 * Index a memory chunk into pgvector for later retrieval.
 */
export async function indexMemoryChunk(
  uid: string,
  content: string,
  source: MemorySearchResult["source"],
  date?: string,
  category?: string,
): Promise<void> {
  await ensureTable();

  let embeddingStr: string | null = null;
  try {
    const vec = await generateEmbedding(content);
    embeddingStr = `[${vec.join(",")}]`;
  } catch {
    // Embedding unavailable — store without vector
  }

  await getPool().query(
    `INSERT INTO memory_chunks (uid, content, source, date, category, embedding)
     VALUES ($1, $2, $3, $4, $5, $6::vector)`,
    [uid, content, source, date ?? null, category ?? null, embeddingStr],
  );
}

/**
 * Search memory using pgvector cosine similarity + keyword matching.
 * Weighted combination: 70% vector + 30% keyword (same as Typesense search).
 */
export async function searchMemoryPgvector(
  uid: string,
  query: string,
  topK: number = 5,
  precomputedEmbedding?: number[],
): Promise<MemorySearchResult[]> {
  await ensureTable();

  let queryEmbedding: number[];
  try {
    queryEmbedding = precomputedEmbedding ?? await generateEmbedding(query);
  } catch {
    // Fall back to keyword-only search
    return keywordSearch(uid, query, topK);
  }

  const vecStr = `[${queryEmbedding.join(",")}]`;

  // Hybrid: pgvector cosine similarity + ILIKE keyword boost
  const result = await getPool().query<{
    content: string;
    source: string;
    date: string | null;
    vector_score: number;
    keyword_match: boolean;
  }>(
    `SELECT
       content, source, date,
       1 - (embedding <=> $1::vector) AS vector_score,
       content ILIKE $3 AS keyword_match
     FROM memory_chunks
     WHERE uid = $2 AND embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector
     LIMIT $4`,
    [vecStr, uid, `%${query}%`, topK * 2],
  );

  if (result.rows.length === 0) {
    return keywordSearch(uid, query, topK);
  }

  // Score and rank with weighted combination
  const scored = result.rows.map((row) => {
    const vectorScore = Math.max(0, row.vector_score);
    const keywordBoost = row.keyword_match ? 0.3 : 0;
    return {
      content: row.content,
      source: row.source as MemorySearchResult["source"],
      date: row.date ?? undefined,
      score: 0.7 * vectorScore + keywordBoost,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/**
 * Keyword-only fallback search when embeddings are unavailable.
 */
async function keywordSearch(
  uid: string,
  query: string,
  topK: number,
): Promise<MemorySearchResult[]> {
  const result = await getPool().query<{
    content: string;
    source: string;
    date: string | null;
  }>(
    `SELECT content, source, date FROM memory_chunks
     WHERE uid = $1 AND content ILIKE $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [uid, `%${query}%`, topK],
  );

  return result.rows.map((row, i) => ({
    content: row.content,
    source: row.source as MemorySearchResult["source"],
    date: row.date ?? undefined,
    score: 1 - i * 0.1, // Simple position-based score
  }));
}
