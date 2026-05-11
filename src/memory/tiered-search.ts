import { createHash } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { generateEmbedding } from "./embeddings.js";
import { searchMemoryPgvector } from "./pg-search.js";
import { searchMemory as searchTypesense } from "./search.js";
import { searchDocuments } from "./rag.js";
import type { MemorySearchResult } from "./types.js";
import type { MemoryProfileConfig } from "./profiles.js";
import type { MemoryFilter } from "../sessions/types.js";
import { isBlockedUrl } from "../utils/ssrf-guard.js";
import { createLogger } from "../utils/logger.js";

const BACKEND_TIMEOUT_MS = process.env.MEMORY_BACKEND_TIMEOUT_MS
  ? parseInt(process.env.MEMORY_BACKEND_TIMEOUT_MS, 10)
  : 2000;

/** Race a promise against a deadline, returning fallback if it times out. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(fallback); },
    );
  });
}

// ── SPLADE Sparse Embeddings ─────────────────────────────────────────
// Optional: if SPLADE_ENDPOINT is set, fetch sparse token weights for
// improved lexical recall on top of BM25.

async function fetchSplaDeEmbedding(query: string): Promise<Record<string, number>> {
  const endpoint = process.env.SPLADE_ENDPOINT;
  if (!endpoint) return {};

  try {
    if (await isBlockedUrl(endpoint)) return {};
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: query }),
      signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
    });
    if (!resp.ok) return {};
    const data = await resp.json() as Record<string, number>;
    return data;
  } catch {
    return {}; // Fall back to BM25
  }
}

// ── 5-Tier Memory Search with HNSW, Graph-Vector Hybrid, RRF ────────
//
// Optimized search across all 5 memory tiers:
//   Tier 1: Ephemeral (session messages in Postgres)
//   Tier 2: Daily (categorized daily notes)
//   Tier 3: Long-term (profiles, knowledge store)
//   Tier 4: Graph (entity relationships with reinforcement)
//   Tier 5: Procedural (learned workflows)
//
// Features:
//   - HNSW indexes tuned per tier (high-write vs high-precision)
//   - Graph-vector hybrid: vector → find nodes → CTE 2-hop expansion
//   - Procedural fast-path: prefix/fuzzy match for instant workflow trigger
//   - RRF (Reciprocal Rank Fusion) for merging Typesense + pgvector results

const log = createLogger("tiered-search");

// ── Negative Result Cache ────────────────────────────────────────────
// When a search returns 0 results, cache that fact for 30 seconds so
// the next identical query skips Postgres + Typesense entirely.
// Key: first 16 hex chars of SHA-256(`${uid}:${query.slice(0,200)}`).
// Value: Date.now() when the empty result was cached.

const NEGATIVE_CACHE_TTL_MS = 30_000;
const negativeCache = new Map<string, number>();

function buildNegativeCacheKey(uid: string, query: string): string {
  return createHash("sha256")
    .update(`${uid}:${query.slice(0, 200)}`)
    .digest("hex")
    .slice(0, 16);
}

// Prune expired entries every 60 seconds (unref'd so it doesn't keep the process alive)
const _negativeCachePruner = setInterval(() => {
  const now = Date.now();
  for (const [key, cachedAt] of negativeCache) {
    if (now - cachedAt > NEGATIVE_CACHE_TTL_MS) {
      negativeCache.delete(key);
    }
  }
}, 60_000);
_negativeCachePruner.unref();

/** Returns observability stats for the negative result cache. */
export function getNegativeCacheStats(): { size: number; ttlMs: number } {
  return { size: negativeCache.size, ttlMs: NEGATIVE_CACHE_TTL_MS };
}

// ── Types ───────────────────────────────────────────────────────────

export interface TieredSearchResult {
  content: string;
  tier: "ephemeral" | "daily" | "longterm" | "graph" | "procedural" | "rag";
  source: string;
  score: number;
  metadata?: Record<string, unknown>;
  /** True when one or more backends timed out and results may be incomplete. */
  degraded?: boolean;
}

export interface GraphVectorResult {
  entityId: string;
  entityName: string;
  entityType: string;
  description: string;
  score: number;
  relatedEntities: Array<{
    entityId: string;
    entityName: string;
    entityType: string;
    edgeType: string;
    hopDistance: number;
  }>;
}

// ── HNSW Index Recommendations ──────────────────────────────────────
//
// These are applied via migration, documented here for reference:
//
// Tier 1 (Ephemeral): High-frequency writes, moderate precision
//   CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)
//   WITH (m = 8, ef_construction = 32);
//   -- Lower m = faster writes, acceptable recall for recent messages
//
// Tier 2-3 (Daily/Long-term): Moderate writes, high precision
//   CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)
//   WITH (m = 16, ef_construction = 64);
//   -- Balanced: good recall with reasonable build time
//
// Tier 4 (Graph): Low-frequency writes, very high precision
//   CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)
//   WITH (m = 24, ef_construction = 128);
//   -- Maximum recall for knowledge graph: entities are precious
//
// Tier 5 (Procedural): Very low writes, exact match preferred
//   CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)
//   WITH (m = 16, ef_construction = 64);

// ── RRF: Reciprocal Rank Fusion ─────────────────────────────────────
// Combines results from multiple retrieval systems (Typesense + pgvector)
// into a single ranked list using the RRF formula:
//   score(d) = Σ 1 / (k + rank_i(d))
// where k = 60 (standard constant from Cormack et al.)

const RRF_K = 60;

export function reciprocalRankFusion(
  ...resultSets: MemorySearchResult[][]
): MemorySearchResult[] {
  const scoreMap = new Map<string, { result: MemorySearchResult; rrfScore: number }>();

  for (const results of resultSets) {
    for (let rank = 0; rank < results.length; rank++) {
      const r = results[rank]!;
      const key = r.content.slice(0, 200); // dedup by content prefix
      const rrfContribution = 1 / (RRF_K + rank + 1);

      const existing = scoreMap.get(key);
      if (existing) {
        existing.rrfScore += rrfContribution;
      } else {
        scoreMap.set(key, { result: r, rrfScore: rrfContribution });
      }
    }
  }

  return [...scoreMap.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map(({ result, rrfScore }) => ({ ...result, score: rrfScore }));
}

// ── Access-count + Recency Boost ─────────────────────────────────────
// Applied as a post-processing step on final tiered results.
// boost = log(1 + accessCount) * exp(-daysSinceLastAccess / 30)
// boostedScore = originalScore * (1 + boost * 0.1)
// Small weight (0.1) ensures semantic scores still dominate.

export function applyAccessBoost(results: TieredSearchResult[]): TieredSearchResult[] {
  const now = Date.now();
  return results.map((r) => {
    const meta = r.metadata as Record<string, unknown> | undefined;
    if (!meta) return r;

    const accessCount = typeof meta.accessCount === "number" ? meta.accessCount : 0;
    const lastAccessedAt = typeof meta.lastAccessedAt === "string" || typeof meta.lastAccessedAt === "number"
      ? new Date(meta.lastAccessedAt as string | number).getTime()
      : null;

    if (accessCount === 0 && !lastAccessedAt) return r;

    const daysSinceAccess = lastAccessedAt
      ? (now - lastAccessedAt) / (1000 * 60 * 60 * 24)
      : 30; // default: 30 days if never accessed

    const recencyDecay = Math.exp(-daysSinceAccess / 30);
    const boost = Math.log(1 + accessCount) * recencyDecay;
    const boostedScore = r.score * (1 + boost * 0.1);

    return { ...r, score: boostedScore };
  });
}

// ── Graph-Vector Hybrid Search ──────────────────────────────────────
// Step 1: Vector search in pgvector to find relevant graph entities
// Step 2: CTE to fetch related entities within 2 hops
// This gives context-aware retrieval: "find what's related to what I asked"

export async function graphVectorHybridSearch(
  uid: string,
  query: string,
  topK: number = 5,
  precomputedEmbedding?: number[],
): Promise<GraphVectorResult[]> {
  const pool = getPool();

  let queryEmbedding: number[];
  try {
    queryEmbedding = precomputedEmbedding ?? await generateEmbedding(query);
  } catch {
    return []; // No embedding available
  }

  const vecStr = `[${queryEmbedding.join(",")}]`;

  // Single query: vector search → CTE 2-hop expansion
  const result = await pool.query<{
    entity_id: string;
    entity_name: string;
    entity_type: string;
    description: string;
    vector_score: number;
    related_id: string | null;
    related_name: string | null;
    related_type: string | null;
    edge_type: string | null;
    hop_distance: number | null;
  }>(
    `WITH seed_entities AS (
       -- Step 1: Vector search finds top-K entities
       SELECT
         id,
         name,
         type,
         description,
         1 - (embedding <=> $1::vector) AS vector_score
       FROM graph_entities
       WHERE uid = $2 AND embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT $3
     ),
     two_hop AS (
       -- Step 2: CTE expands to 2-hop related entities
       SELECT
         se.id AS seed_id,
         se.vector_score,
         related.id AS related_id,
         related.name AS related_name,
         related.type AS related_type,
         edge.type AS edge_type,
         1 AS hop_distance
       FROM seed_entities se
       JOIN graph_edges edge ON edge.uid = $2
         AND (edge.source_id = se.id OR edge.target_id = se.id)
       JOIN graph_entities related ON related.uid = $2
         AND related.id = CASE
           WHEN edge.source_id = se.id THEN edge.target_id
           ELSE edge.source_id
         END

       UNION ALL

       -- Second hop
       SELECT
         th.seed_id,
         th.vector_score,
         r2.id AS related_id,
         r2.name AS related_name,
         r2.type AS related_type,
         e2.type AS edge_type,
         2 AS hop_distance
       FROM two_hop th
       JOIN graph_edges e2 ON e2.uid = $2
         AND (e2.source_id = th.related_id OR e2.target_id = th.related_id)
       JOIN graph_entities r2 ON r2.uid = $2
         AND r2.id = CASE
           WHEN e2.source_id = th.related_id THEN e2.target_id
           ELSE e2.source_id
         END
       WHERE th.hop_distance = 1
         AND r2.id != th.seed_id
     )
     SELECT
       se.id AS entity_id,
       se.name AS entity_name,
       se.type AS entity_type,
       se.description,
       se.vector_score,
       th.related_id,
       th.related_name,
       th.related_type,
       th.edge_type,
       th.hop_distance
     FROM seed_entities se
     LEFT JOIN two_hop th ON th.seed_id = se.id
     ORDER BY se.vector_score DESC, th.hop_distance ASC NULLS LAST`,
    [vecStr, uid, topK],
  );

  // Group results by seed entity
  const entityMap = new Map<string, GraphVectorResult>();

  for (const row of result.rows) {
    if (!entityMap.has(row.entity_id)) {
      entityMap.set(row.entity_id, {
        entityId: row.entity_id,
        entityName: row.entity_name,
        entityType: row.entity_type,
        description: row.description,
        score: Math.max(0, row.vector_score),
        relatedEntities: [],
      });
    }

    if (row.related_id && row.related_name) {
      const entity = entityMap.get(row.entity_id)!;
      // Avoid duplicates
      if (!entity.relatedEntities.some((r) => r.entityId === row.related_id)) {
        entity.relatedEntities.push({
          entityId: row.related_id,
          entityName: row.related_name,
          entityType: row.related_type ?? "concept",
          edgeType: row.edge_type ?? "related_to",
          hopDistance: row.hop_distance ?? 1,
        });
      }
    }
  }

  return [...entityMap.values()];
}

// ── Procedural Fast-Path ────────────────────────────────────────────
// Before the LLM even finishes processing, check if the user's query
// matches a learned workflow via prefix/fuzzy matching.
// Returns immediately if a workflow is found, enabling instant triggers.

export async function proceduralFastPath(
  uid: string,
  query: string,
): Promise<{
  matched: boolean;
  procedureId?: string;
  title?: string;
  triggerPattern?: string;
  steps?: unknown[];
  confidence: number;
}> {
  const pool = getPool();

  // Check trigram/prefix match on trigger_pattern and title
  const result = await pool.query<{
    id: string;
    title: string;
    trigger_pattern: string;
    steps: unknown[];
    execution_count: number;
    success_count: number;
  }>(
    `SELECT id, title, trigger_pattern, steps, execution_count, success_count
     FROM procedural_memory
     WHERE user_id = $1
       AND (
         trigger_pattern ILIKE $2
         OR title ILIKE $2
         OR trigger_pattern ILIKE $3
         OR title ILIKE $3
       )
     ORDER BY
       -- Boost by success rate and execution frequency
       (CASE WHEN execution_count > 0
         THEN success_count::float / execution_count
         ELSE 0.5 END) * LN(execution_count + 1) DESC
     LIMIT 1`,
    [uid, `%${query}%`, `%${query.split(" ").slice(0, 3).join("%")}%`],
  );

  if (result.rows.length === 0) {
    return { matched: false, confidence: 0 };
  }

  const row = result.rows[0]!;
  const successRate = row.execution_count > 0
    ? row.success_count / row.execution_count
    : 0.5;

  return {
    matched: true,
    procedureId: row.id,
    title: row.title,
    triggerPattern: row.trigger_pattern,
    steps: row.steps,
    confidence: Math.min(1, successRate * 0.7 + 0.3), // base 0.3 + success bonus
  };
}

// ── Reinforcement Score Update ───────────────────────────────────────
// Updates graph entity reinforcement_score based on successful tool usage.
// Boosts entities that are associated with successful outcomes.

export async function reinforceByToolSuccess(
  uid: string,
  entityIds: string[],
  toolName: string,
  success: boolean,
): Promise<void> {
  if (entityIds.length === 0) return;

  const pool = getPool();
  const delta = success ? 0.1 : -0.02; // reward success, slight penalty for failure

  await pool.query(
    `UPDATE graph_entities
     SET reinforcement_score = GREATEST(0.01, LEAST(10.0, reinforcement_score + $1)),
         access_count = access_count + 1,
         last_accessed_at = NOW()
     WHERE uid = $2 AND id = ANY($3::uuid[])`,
    [delta, uid, entityIds],
  );

  log.dim(`Reinforced ${entityIds.length} entities (${toolName}: ${success ? "success" : "fail"}, delta: ${delta})`);
}

// ── Full Tiered Search ──────────────────────────────────────────────
// Searches across all 5 tiers with RRF fusion for combined ranking.

// Tier number → TieredSearchResult.tier mapping
const TIER_NUMBER_MAP: Record<number, TieredSearchResult["tier"]> = {
  1: "ephemeral",
  2: "daily",
  3: "longterm",
  4: "graph",
  5: "procedural",
  6: "rag",
};

function tierNumberAllowed(tier: TieredSearchResult["tier"], allowTiers: number[]): boolean {
  const tierToNumber: Record<TieredSearchResult["tier"], number> = {
    ephemeral: 1,
    daily: 2,
    longterm: 3,
    graph: 4,
    procedural: 5,
    rag: 6,
  };
  return allowTiers.includes(tierToNumber[tier]);
}

export async function searchAllTiers(
  uid: string,
  query: string,
  topK: number = 10,
  profile?: MemoryProfileConfig,
  memoryFilter?: MemoryFilter,
): Promise<TieredSearchResult[]> {
  // ── Negative result cache check ──────────────────────────────────
  // If the exact same uid:query returned empty results recently, skip backends.
  const negativeCacheKey = buildNegativeCacheKey(uid, query);
  const negativeCachedAt = negativeCache.get(negativeCacheKey);
  if (negativeCachedAt !== undefined && Date.now() - negativeCachedAt <= NEGATIVE_CACHE_TTL_MS) {
    return [];
  }

  // Apply profile overrides: maxContextChunks replaces topK when provided
  const effectiveTopK = profile?.maxContextChunks ?? topK;
  const minScore = profile?.minRelevanceScore ?? 0;
  const tiers = profile?.tiersEnabled ?? {
    session: true,
    daily: true,
    profile: true,
    graph: true,
    procedural: true,
    rag: true,
  };

  // Apply memoryFilter.allowTiers: disable tiers not in the allowed list
  if (memoryFilter?.allowTiers && memoryFilter.allowTiers.length > 0) {
    const allowed = memoryFilter.allowTiers;
    if (!allowed.includes(1)) tiers.session = false;
    if (!allowed.includes(2)) tiers.daily = false;
    if (!allowed.includes(3)) tiers.profile = false;
    if (!allowed.includes(4)) tiers.graph = false;
    if (!allowed.includes(5)) tiers.procedural = false;
    if (!allowed.includes(6)) tiers.rag = false;
  }

  // Avoid unused variable warning for TIER_NUMBER_MAP
  void TIER_NUMBER_MAP;

  // Track whether any backend timed out (partial degradation)
  let degraded = false;

  function timedBackend<T>(p: Promise<T>, fallback: T, name: string): Promise<T> {
    const withFallback = p.catch(() => fallback);
    const raced = withTimeout(withFallback, BACKEND_TIMEOUT_MS, fallback);
    // Detect timeout by racing the original promise against the deadline
    const timeoutSentinel = new Promise<"timed-out">((resolve) =>
      setTimeout(() => resolve("timed-out"), BACKEND_TIMEOUT_MS),
    );
    Promise.race([p.then(() => "ok" as const).catch(() => "err" as const), timeoutSentinel]).then(
      (result) => {
        if (result === "timed-out") {
          degraded = true;
          log.warn(`Backend "${name}" timed out after ${BACKEND_TIMEOUT_MS}ms — partial results`);
        }
      },
    );
    return raced;
  }

  // Pre-compute embedding once for all vector-search backends
  let queryEmbedding: number[] | undefined;
  try {
    queryEmbedding = await generateEmbedding(query);
  } catch {
    // Embedding unavailable — backends will fall back to keyword search
  }

  // Optionally fetch SPLADE sparse embeddings in parallel (best-effort)
  const splaDePromise = process.env.SPLADE_ENDPOINT
    ? fetchSplaDeEmbedding(query)
    : Promise.resolve({} as Record<string, number>);

  // Determine which tier searches to run based on profile config.
  // session + daily + profile tiers all map to the pgvector/Typesense backends;
  // we skip those backends only when all three of those tiers are disabled.
  const runMemoryBackends = tiers.session || tiers.daily || tiers.profile;
  const runGraph = tiers.graph;
  const runProcedural = tiers.procedural;
  const runRag = tiers.rag ?? true;

  // Run enabled searches in parallel with per-backend timeout protection
  const [pgResults, tsResults, graphResults, proceduralResult, ragResults] = await Promise.all([
    runMemoryBackends
      ? timedBackend(searchMemoryPgvector(uid, query, effectiveTopK, queryEmbedding), [] as MemorySearchResult[], "pgvector")
      : Promise.resolve([] as MemorySearchResult[]),
    runMemoryBackends
      ? timedBackend(searchTypesense(uid, query, effectiveTopK, queryEmbedding), [] as MemorySearchResult[], "typesense")
      : Promise.resolve([] as MemorySearchResult[]),
    runGraph
      ? timedBackend(graphVectorHybridSearch(uid, query, Math.ceil(effectiveTopK / 2), queryEmbedding), [] as GraphVectorResult[], "graph")
      : Promise.resolve([] as GraphVectorResult[]),
    runProcedural
      ? timedBackend(
          proceduralFastPath(uid, query),
          { matched: false as const, confidence: 0 },
          "procedural",
        )
      : Promise.resolve({ matched: false as const, confidence: 0 }),
    runRag
      ? timedBackend(searchDocuments(uid, query, Math.ceil(effectiveTopK / 2), undefined, queryEmbedding), [] as import("./rag.js").RAGSearchResult[], "rag")
      : Promise.resolve([] as import("./rag.js").RAGSearchResult[]),
  ]);

  // Log SPLADE result (available for future Typesense integration)
  const splaDeWeights = await withTimeout(splaDePromise, BACKEND_TIMEOUT_MS, {});
  if (process.env.SPLADE_ENDPOINT && Object.keys(splaDeWeights).length > 0) {
    log.dim(`SPLADE: ${Object.keys(splaDeWeights).length} sparse tokens for query`);
  }

  // RRF fusion of pgvector + Typesense results
  const fusedMemory = reciprocalRankFusion(pgResults, tsResults);

  // Convert to tiered results
  const results: TieredSearchResult[] = [];

  for (const r of fusedMemory.slice(0, effectiveTopK)) {
    // Apply per-tier filtering based on the result source
    const sourceTier = r.source === "session" ? "session" : r.source === "daily" ? "daily" : "profile";
    if (!tiers[sourceTier]) continue;

    const item: TieredSearchResult = {
      content: r.content,
      tier: r.source === "session" ? "ephemeral" : r.source === "daily" ? "daily" : "longterm",
      source: r.source,
      score: r.score,
      degraded,
    };
    results.push(item);
  }

  // Add graph results
  if (runGraph) {
    for (const g of graphResults) {
      const relatedContext = g.relatedEntities.length > 0
        ? ` [Related: ${g.relatedEntities.slice(0, 3).map((r) => r.entityName).join(", ")}]`
        : "";
      results.push({
        content: `${g.entityName} (${g.entityType}): ${g.description}${relatedContext}`,
        tier: "graph",
        source: "graph",
        score: g.score,
        degraded,
        metadata: {
          entityId: g.entityId,
          relatedCount: g.relatedEntities.length,
        },
      });
    }
  }

  // Add procedural fast-path if matched
  if (runProcedural && proceduralResult.matched && proceduralResult.confidence > 0.5 && "title" in proceduralResult) {
    results.push({
      content: `[Workflow: ${proceduralResult.title}] Trigger: ${proceduralResult.triggerPattern}`,
      tier: "procedural",
      source: "procedural",
      score: proceduralResult.confidence,
      degraded,
      metadata: {
        procedureId: proceduralResult.procedureId,
        steps: proceduralResult.steps,
      },
    });
  }

  // Add RAG document results
  if (runRag) {
    for (const r of ragResults) {
      const heading = r.chunk.heading ? ` (${r.chunk.heading})` : "";
      results.push({
        content: `[Doc: ${r.document.title}${heading}] ${r.chunk.content}`,
        tier: "rag",
        source: "rag",
        score: r.score,
        degraded,
        metadata: {
          documentId: r.document.id,
          chunkIndex: r.chunk.index,
          format: r.document.format,
        },
      });
    }
  }

  // Apply access-count + recency boost before final sort
  const boosted = applyAccessBoost(results);

  // Sort by score descending, then apply minRelevanceScore filter and cap to effectiveTopK
  boosted.sort((a, b) => b.score - a.score);
  let filtered = minScore > 0 ? boosted.filter((r) => r.score >= minScore) : boosted;

  // Apply memoryFilter.allowTiers: post-filter by tier number (belt-and-suspenders)
  if (memoryFilter?.allowTiers && memoryFilter.allowTiers.length > 0) {
    filtered = filtered.filter((r) => tierNumberAllowed(r.tier, memoryFilter.allowTiers!));
  }

  // Apply memoryFilter.denyTags: exclude results whose metadata tags overlap denyTags
  if (memoryFilter?.denyTags && memoryFilter.denyTags.length > 0) {
    const denySet = new Set(memoryFilter.denyTags);
    filtered = filtered.filter((r) => {
      const meta = r.metadata as Record<string, unknown> | undefined;
      if (!meta) return true;
      const tags = meta.tags;
      if (Array.isArray(tags)) {
        return !tags.some((t) => typeof t === "string" && denySet.has(t));
      }
      return true;
    });
  }

  const finalResults = filtered.slice(0, effectiveTopK);

  // ── Negative result cache write ──────────────────────────────────
  // Cache the "no results" fact so the next identical query is short-circuited.
  if (finalResults.length === 0) {
    negativeCache.set(negativeCacheKey, Date.now());
  }

  return finalResults;
}
