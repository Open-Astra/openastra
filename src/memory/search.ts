import { getTypesense } from "../config/typesense.js";
import { generateEmbedding } from "./embeddings.js";
import type { MemorySearchResult } from "./types.js";

const COLLECTION = "memory_chunks";

// ── Hybrid Search ───────────────────────────────────────────────────
// Implements the OpenClaw search pattern: BM25 keyword (30%) + cosine
// vector similarity (70%), combined via union (not intersection) to
// maximize recall.
//
// Typesense supports this natively with multi_search or by using
// vector search with a text query fallback. We use the vector_query
// parameter alongside q for hybrid ranking.

export async function searchMemory(
  uid: string,
  query: string,
  topK: number = 5,
  precomputedEmbedding?: number[],
): Promise<MemorySearchResult[]> {
  const ts = getTypesense();

  // Generate query embedding for vector search
  const queryEmbedding = precomputedEmbedding ?? await generateEmbedding(query);

  // Use multiSearch (POST) to avoid the 4000-char URL length limit —
  // a 768-dim float vector serialized in query_by exceeds GET limits.
  const multiResult = await ts.multiSearch.perform(
    {
      searches: [
        {
          collection: COLLECTION,
          q: query,
          query_by: "content",
          filter_by: `uid:=${uid}`,
          sort_by: "_text_match:desc,_vector_distance:asc",
          vector_query: `embedding:([${queryEmbedding.join(",")}], k:${topK * 2})`,
          per_page: topK,
          exclude_fields: "embedding",
        },
      ],
    },
    {},
  );

  const results = multiResult.results[0] as {
    hits?: Array<{
      document: Record<string, unknown>;
      text_match?: number;
      vector_distance?: number;
    }>;
  };

  if (!results?.hits?.length) return [];

  return results.hits.map((hit) => {
    const doc = hit.document;

    // Combine text match score (BM25) and vector distance into a
    // unified relevance score. Typesense provides text_match as a
    // positive score (higher = better) and vector_distance as a
    // distance metric (lower = better, 0-2 range for cosine).
    const textScore = hit.text_match ?? 0;
    const vectorDistance = hit.vector_distance ?? 2;

    // Normalize: text_match is unbounded, so we cap and scale it.
    // Vector distance is 0-2 for cosine, convert to 0-1 similarity.
    const normalizedText = Math.min(textScore / 1000000, 1);
    const vectorSimilarity = 1 - vectorDistance / 2;

    // Weighted combination: 30% BM25 + 70% vector
    const score = 0.3 * normalizedText + 0.7 * vectorSimilarity;

    return {
      content: doc.content as string,
      source: doc.source as MemorySearchResult["source"],
      date: doc.date as string | undefined,
      score,
    };
  });
}
