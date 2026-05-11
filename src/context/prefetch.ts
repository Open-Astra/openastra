import { searchMemory } from "../memory/search.js";
import { graphSearch, type GraphSearchResult } from "../memory/graph.js";
import { searchProcedures, renderProcedure, type ProcedureSearchResult } from "../memory/procedural.js";
import type { MessageDoc } from "../sessions/types.js";

// ── Predictive Prefetch ─────────────────────────────────────────────
// Before any new query, proactively pulls the top-N most relevant
// memory chunks using a multi-signal scorer:
//   1. Semantic similarity (vector) to the current message
//   2. Graph neighborhood of mentioned entities
//   3. Matching procedural memories
//   4. Time-of-day patterns (e.g., morning → briefing context)
//   5. Recency-weighted session history
//
// Returns pre-formatted context blocks ready for injection into the
// system prompt, reducing token waste and latency vs. reactive retrieval.

// ── Types ───────────────────────────────────────────────────────────

export interface PrefetchResult {
  memoryContext: string;       // formatted memory chunks
  procedureContext: string;    // formatted matching procedures
  graphContext: string;        // formatted graph neighborhood
  totalChunks: number;
  estimatedTokens: number;
}

// ── Scoring Weights ─────────────────────────────────────────────────

const WEIGHTS = {
  memory: 0.35,
  graph: 0.30,
  procedure: 0.20,
  recency: 0.15,
};

const MAX_PREFETCH_TOKENS = 2000; // budget for prefetched context

// ── Main Prefetch Function ──────────────────────────────────────────

export async function prefetchContext(
  uid: string,
  currentMessage: string,
  recentMessages: MessageDoc[],
): Promise<PrefetchResult> {
  // Build a composite query from the current message + recent context
  const querySignal = buildQuerySignal(currentMessage, recentMessages);

  // Run all searches in parallel
  const [memoryResults, graphResults, procedureResults] = await Promise.all([
    searchMemory(uid, querySignal, 5).catch(() => []),
    graphSearch(uid, querySignal, 3).catch(() => [] as GraphSearchResult[]),
    searchProcedures(uid, querySignal, 2).catch(() => [] as ProcedureSearchResult[]),
  ]);

  // Format each result type
  const memoryContext = formatMemoryResults(memoryResults);
  const graphContext = formatGraphResults(graphResults);
  const procedureContext = formatProcedureResults(procedureResults);

  // Estimate tokens
  const allContext = [memoryContext, graphContext, procedureContext].filter(Boolean);
  const estimatedTokens = Math.ceil(allContext.join("").length / 4);

  // Trim if over budget
  let finalMemory = memoryContext;
  let finalGraph = graphContext;
  let finalProcedure = procedureContext;

  if (estimatedTokens > MAX_PREFETCH_TOKENS) {
    // Prioritize: procedures > graph > memory (procedures are most actionable)
    const budget = MAX_PREFETCH_TOKENS * 4; // chars
    let remaining = budget;

    finalProcedure = procedureContext.slice(0, Math.floor(remaining * WEIGHTS.procedure));
    remaining -= finalProcedure.length;

    finalGraph = graphContext.slice(0, Math.floor(remaining * WEIGHTS.graph));
    remaining -= finalGraph.length;

    finalMemory = memoryContext.slice(0, remaining);
  }

  return {
    memoryContext: finalMemory,
    procedureContext: finalProcedure,
    graphContext: finalGraph,
    totalChunks: memoryResults.length + graphResults.length + procedureResults.length,
    estimatedTokens: Math.ceil(
      (finalMemory.length + finalGraph.length + finalProcedure.length) / 4,
    ),
  };
}

// ── Query Signal Builder ────────────────────────────────────────────
// Combines the current message with recent conversation context
// and time-of-day signals for better retrieval relevance.

function buildQuerySignal(currentMessage: string, recentMessages: MessageDoc[]): string {
  const parts: string[] = [currentMessage];

  // Add context from last 3 user messages
  const recentUserMsgs = recentMessages
    .filter((m) => m.role === "user")
    .slice(-3)
    .map((m) => m.content);
  parts.push(...recentUserMsgs);

  // Add time-of-day signal
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) parts.push("morning briefing daily");
  else if (hour >= 17 && hour < 23) parts.push("evening games tonight");
  else if (hour >= 23 || hour < 5) parts.push("late night recap");

  return parts.join(" ").slice(0, 500); // cap query length
}

// ── Formatters ──────────────────────────────────────────────────────

function formatMemoryResults(results: Array<{ content: string; source: string; score: number }>): string {
  if (results.length === 0) return "";

  const lines = results
    .filter((r) => r.score > 0.3) // only high-relevance
    .map((r) => `- [${r.source}] ${r.content}`);

  if (lines.length === 0) return "";
  return "Relevant memories:\n" + lines.join("\n");
}

function formatGraphResults(results: GraphSearchResult[]): string {
  if (results.length === 0) return "";

  const lines: string[] = [];
  for (const r of results) {
    lines.push(`- ${r.entity.name} (${r.entity.type}): ${r.entity.description || "no description"}`);
    if (r.connectedEntities?.length) {
      for (const conn of r.connectedEntities.slice(0, 3)) {
        lines.push(`  → ${conn.edge.type} → ${conn.entity.name}`);
      }
    }
  }

  return "Knowledge graph context:\n" + lines.join("\n");
}

function formatProcedureResults(results: ProcedureSearchResult[]): string {
  if (results.length === 0) return "";

  const rendered = results
    .filter((r) => r.score > 0.5)
    .map((r) => renderProcedure(r.procedure));

  if (rendered.length === 0) return "";
  return "Relevant procedures:\n" + rendered.join("\n\n");
}
