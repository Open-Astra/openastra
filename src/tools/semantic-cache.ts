// ── Semantic Tool Result Cache (Feature 35) ─────────────────────────
// Extends exact-match tool caching with SimHash-based semantic
// similarity lookup. When a new query is semantically similar to a
// cached result (low hamming distance), return the cached result.
// Temporally stale entries are invalidated even if semantically matched.

import { createHash } from "node:crypto";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("semantic-tool-cache");

// Import TTLs from the exact-match cache
// These are re-exported after the edit to cache.ts
const DEFAULT_TTL_MS = 5 * 60_000;
const TOOL_TTLS: Record<string, number> = {
  prop_lookup: 60_000,
  line_compare: 60_000,
  x_search: 2 * 60_000,
  model_inference: 5 * 60_000,
  brave_search: 3 * 60_000,
  memory_search: 30_000,
  sql_query: 60_000,
};

// Tools that should never be cached (side-effects)
const NEVER_CACHE = new Set([
  "memory_write", "knowledge_ingest", "knowledge_delete", "push_notify",
  "send_email", "send_webhook", "agent_spawn", "file_write", "shell_execute",
  "auto_extract_facts", "auto_save_summary", "run_workflow", "run_parallel_steps",
  "run_procedure", "find_and_run_procedure", "memory_consolidate_daily",
  "memory_promote_themes", "memory_decay_graph", "memory_consolidate_full",
  "vector_ingest", "vector_batch_ingest", "vector_create_collection",
]);

// ── Types ────────────────────────────────────────────────────────────

interface SemanticCacheEntry {
  toolName: string;
  queryText: string;
  simHash: number[];
  result: string;
  cachedAt: number;
  expiresAt: number;
  hitCount: number;
}

interface SemanticCacheStats {
  size: number;
  tools: Record<string, { entries: number; hits: number }>;
}

// ── SimHash Implementation ───────────────────────────────────────────
// Generates a fixed-width binary fingerprint from text using word
// n-gram hashing. Similar texts produce similar hashes.

const SIM_HASH_DIMS = 64;

export function simHashText(text: string, dims = SIM_HASH_DIMS): number[] {
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  const words = normalized.split(/\s+/).filter(Boolean);

  if (words.length === 0) return new Array(dims).fill(0);

  // Generate n-grams (unigrams + bigrams)
  const ngrams: string[] = [...words];
  for (let i = 0; i < words.length - 1; i++) {
    ngrams.push(`${words[i]} ${words[i + 1]}`);
  }

  // Accumulate weighted bit vectors
  const v = new Array(dims).fill(0);

  for (const ngram of ngrams) {
    const hash = createHash("md5").update(ngram).digest();

    for (let i = 0; i < dims; i++) {
      const byteIdx = Math.floor(i / 8) % hash.length;
      const bitIdx = i % 8;
      const bit = (hash[byteIdx]! >> bitIdx) & 1;
      v[i] += bit === 1 ? 1 : -1;
    }
  }

  // Convert to binary
  return v.map((val) => (val >= 0 ? 1 : 0));
}

export function hammingDistance(a: number[], b: number[]): number {
  let dist = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) dist++;
  }
  return dist;
}

// ── In-Memory Semantic Cache ─────────────────────────────────────────

const MAX_ENTRIES = 300;
const DEFAULT_HAMMING_THRESHOLD = 8; // out of 64 bits

// Keyed by toolName for fast scoped lookups
const semanticCache = new Map<string, SemanticCacheEntry[]>();

function getToolTtl(toolName: string): number {
  return TOOL_TTLS[toolName] ?? DEFAULT_TTL_MS;
}

function shouldSemanticCache(toolName: string): boolean {
  return !NEVER_CACHE.has(toolName);
}

function totalEntries(): number {
  let count = 0;
  for (const entries of semanticCache.values()) count += entries.length;
  return count;
}

export function getSemanticCachedResult(
  toolName: string,
  queryText: string,
  threshold = DEFAULT_HAMMING_THRESHOLD,
): string | null {
  if (!shouldSemanticCache(toolName)) return null;

  const entries = semanticCache.get(toolName);
  if (!entries || entries.length === 0) return null;

  const queryHash = simHashText(queryText);
  const now = Date.now();
  let bestMatch: SemanticCacheEntry | null = null;
  let bestDistance = Infinity;

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;

    // Check temporal staleness
    if (now > entry.expiresAt) {
      entries.splice(i, 1);
      continue;
    }

    const dist = hammingDistance(queryHash, entry.simHash);
    if (dist < bestDistance) {
      bestDistance = dist;
      bestMatch = entry;
    }
  }

  if (bestMatch && bestDistance <= threshold) {
    bestMatch.hitCount++;
    logger.dim(`Semantic cache hit for ${toolName} (hamming=${bestDistance})`);
    return bestMatch.result;
  }

  return null;
}

export function setSemanticCachedResult(
  toolName: string,
  queryText: string,
  result: string,
): void {
  if (!shouldSemanticCache(toolName)) return;

  // Evict if over capacity
  if (totalEntries() >= MAX_ENTRIES) {
    evictOldest();
  }

  const ttl = getToolTtl(toolName);
  const entry: SemanticCacheEntry = {
    toolName,
    queryText: queryText.slice(0, 1000),
    simHash: simHashText(queryText),
    result,
    cachedAt: Date.now(),
    expiresAt: Date.now() + ttl,
    hitCount: 0,
  };

  let entries = semanticCache.get(toolName);
  if (!entries) {
    entries = [];
    semanticCache.set(toolName, entries);
  }
  entries.push(entry);
}

export function getSemanticCacheStats(): SemanticCacheStats {
  const tools: Record<string, { entries: number; hits: number }> = {};
  let size = 0;

  for (const [toolName, entries] of semanticCache) {
    let hits = 0;
    for (const e of entries) hits += e.hitCount;
    tools[toolName] = { entries: entries.length, hits };
    size += entries.length;
  }

  return { size, tools };
}

export function clearSemanticCache(toolName?: string): number {
  if (!toolName) {
    const count = totalEntries();
    semanticCache.clear();
    return count;
  }

  const entries = semanticCache.get(toolName);
  if (!entries) return 0;
  const count = entries.length;
  semanticCache.delete(toolName);
  return count;
}

// ── Eviction ─────────────────────────────────────────────────────────

function evictOldest(): void {
  let oldest: { toolName: string; idx: number; cachedAt: number } | null = null;

  for (const [toolName, entries] of semanticCache) {
    for (let i = 0; i < entries.length; i++) {
      if (!oldest || entries[i]!.cachedAt < oldest.cachedAt) {
        oldest = { toolName, idx: i, cachedAt: entries[i]!.cachedAt };
      }
    }
  }

  if (oldest) {
    semanticCache.get(oldest.toolName)?.splice(oldest.idx, 1);
  }
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [toolName, entries] of semanticCache) {
    const filtered = entries.filter((e) => now <= e.expiresAt);
    if (filtered.length === 0) {
      semanticCache.delete(toolName);
    } else {
      semanticCache.set(toolName, filtered);
    }
  }
}

// Periodic cleanup every 2 minutes
setInterval(pruneExpired, 2 * 60_000).unref();
