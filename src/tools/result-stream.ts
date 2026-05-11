// ── Tool Result Streaming ─────────────────────────────────────────────
// Wraps large tool results in a streaming reader pattern.
// Results larger than 10KB are yielded in chunks instead of returned
// as a single large string.

const DEFAULT_CHUNK_SIZE = 4096; // 4KB per chunk
const STREAM_THRESHOLD = 10_000; // 10KB

/**
 * Returns true if the content is large enough to warrant streaming.
 */
export function shouldStream(content: string): boolean {
  return content.length > STREAM_THRESHOLD;
}

/**
 * Yields the content in fixed-size chunks as an async iterable.
 * Useful for large tool results that should not be held entirely in memory.
 *
 * @param content - The full content string to stream
 * @param chunkSize - Size of each chunk in characters (default 4096)
 */
export async function* streamLargeResult(
  content: string,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): AsyncIterable<string> {
  if (chunkSize <= 0) {
    throw new RangeError("chunkSize must be a positive integer");
  }

  let offset = 0;
  while (offset < content.length) {
    yield content.slice(offset, offset + chunkSize);
    offset += chunkSize;
    // Yield control back to the event loop between chunks
    await Promise.resolve();
  }
}
