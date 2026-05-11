import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("embedding-batcher");

const FLUSH_INTERVAL_MS = 100;   // coalesce within 100ms window
const MAX_BATCH_SIZE = 50;       // flush immediately if batch exceeds this

interface PendingWrite {
  textHash: string;
  embedding: number[];
  resolve: () => void;
  reject: (err: unknown) => void;
}

let pending: PendingWrite[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

async function flush(): Promise<void> {
  if (pending.length === 0) return;

  const batch = pending.splice(0);
  flushTimer = null;

  try {
    const pool = getPool();
    // Build multi-row INSERT — all rows in one round-trip
    const values: unknown[] = [];
    const placeholders: string[] = [];

    for (let i = 0; i < batch.length; i++) {
      const row = batch[i]!;
      const base = i * 2;
      placeholders.push(`($${base + 1}, $${base + 2}::vector)`);
      values.push(row.textHash, `[${row.embedding.join(",")}]`);
    }

    await pool.query(
      `INSERT INTO embedding_cache (text_hash, embedding)
       VALUES ${placeholders.join(", ")}
       ON CONFLICT (text_hash) DO NOTHING`,
      values,
    );

    for (const w of batch) w.resolve();
    log.dim(`Flushed ${batch.length} embeddings in one batch`);
  } catch (err) {
    for (const w of batch) w.reject(err);
  }
}

function scheduledFlush(): void {
  if (!flushTimer) {
    flushTimer = setTimeout(() => { flush().catch(() => {}); }, FLUSH_INTERVAL_MS);
  }
}

/**
 * Queue an embedding write. Returns a promise that resolves when the batch is committed.
 * If the batch exceeds MAX_BATCH_SIZE, flushes immediately.
 */
export function queueEmbeddingWrite(textHash: string, embedding: number[]): Promise<void> {
  return new Promise((resolve, reject) => {
    pending.push({ textHash, embedding, resolve, reject });
    if (pending.length >= MAX_BATCH_SIZE) {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      flush().catch(() => {});
    } else {
      scheduledFlush();
    }
  });
}

/** Force an immediate flush (call on graceful shutdown). */
export async function flushEmbeddingBatcher(): Promise<void> {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  await flush();
}
