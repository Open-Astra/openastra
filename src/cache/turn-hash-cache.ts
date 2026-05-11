import { createHash } from "node:crypto";
import { createLogger } from "../utils/logger.js";
import type { InferenceRequest } from "../inference/types.js";

const log = createLogger("turn-hash-cache");

const TTL_MS = 5 * 60_000; // 5 minutes
const MAX_ENTRIES = 200;

interface TurnCacheEntry {
  response: string;
  expiresAt: number;
}

const cache = new Map<string, TurnCacheEntry>();

// Periodic cleanup of expired entries
const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (v.expiresAt <= now) cache.delete(k);
  }
}, 60_000);
if (cleanup.unref) cleanup.unref();

/**
 * Compute a deterministic cache key from an inference request.
 * Excludes streaming flag and metadata — only stable content matters.
 */
export function hashRequest(request: InferenceRequest): string {
  const stable = {
    messages: request.messages,
    tools: request.tools?.map((t) => t.function.name).sort(),
    maxTokens: request.maxTokens,
    temperature: request.temperature,
  };
  return createHash("sha256")
    .update(JSON.stringify(stable))
    .digest("hex");
}

/**
 * Check if an identical request was recently answered.
 * Returns the cached response string, or undefined on miss.
 */
export function getTurnCache(request: InferenceRequest): string | undefined {
  const key = hashRequest(request);
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  log.dim(`Turn cache hit (key=${key.slice(0, 8)}…)`);
  return entry.response;
}

/**
 * Store a response for an inference request.
 */
export function setTurnCache(request: InferenceRequest, response: string): void {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  const key = hashRequest(request);
  cache.set(key, { response, expiresAt: Date.now() + TTL_MS });
}

export function getTurnCacheStats(): { size: number; maxSize: number } {
  return { size: cache.size, maxSize: MAX_ENTRIES };
}
