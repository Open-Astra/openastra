import { z } from "zod";
import { registerTool } from "./registry.js";
import { searchMemory } from "../memory/search.js";

// ── memory_search ───────────────────────────────────────────────────
// Semantic search across the user's memory corpus. Uses Typesense's
// hybrid BM25 + vector search (30/70 weighting per OpenClaw pattern).

const MemorySearchParams = z.object({
  query: z.string().describe("Natural language search query"),
  topK: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(5)
    .describe("Number of results to return"),
});

registerTool({
  name: "memory_search",
  description:
    "Search the user's memory for relevant past context — bet history, decisions, strategies, preferences, and prior conversations. Use this when the user references something from the past or when you need context to give better advice.",
  parameters: MemorySearchParams,

  async execute(params, ctx) {
    const results = await searchMemory(ctx.uid, params.query, params.topK);

    if (results.length === 0) {
      return {
        results: [],
        message: "No relevant memories found.",
      };
    }

    return {
      results: results.map((r) => ({
        content: r.content,
        source: r.source,
        date: r.date,
        relevance: Math.round(r.score * 100) / 100,
      })),
      message: `Found ${results.length} relevant memories.`,
    };
  },
});
