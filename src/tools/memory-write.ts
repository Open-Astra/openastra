import { z } from "zod";
import { registerTool } from "./registry.js";
import { appendDailyMemory, getDailyEntryCount } from "../memory/store.js";
import { indexDailyEntry } from "../memory/indexer.js";
import { invalidateSemanticCacheForAgent } from "../cache/semantic.js";

// ── memory_write ────────────────────────────────────────────────────
// Writes to the user's daily memory log AND indexes into Typesense
// for hybrid search retrieval. The agent calls this to persist
// important context: bet decisions, outcomes, strategy notes.

const MemoryWriteParams = z.object({
  category: z
    .enum(["decision", "outcome", "strategy", "note", "interaction"])
    .describe("Category of the memory entry"),
  content: z.string().describe("The memory content to persist"),
});

registerTool({
  name: "memory_write",
  description:
    "Save important information to the user's daily memory log. Use this for bet decisions, outcomes, strategy notes, and key interactions worth remembering.",
  parameters: MemoryWriteParams,

  async execute(params, ctx) {
    const now = Date.now();
    const date = new Date(now).toISOString().slice(0, 10);

    // Get current entry count before appending (for index position)
    const entryCount = await getDailyEntryCount(ctx.uid, date);

    // Write to Firestore
    await appendDailyMemory(ctx.uid, {
      timestamp: now,
      category: params.category,
      content: params.content,
    });

    // Index into Typesense for hybrid search (fire-and-forget, don't block response)
    indexDailyEntry(
      ctx.uid,
      date,
      entryCount,
      params.category,
      params.content,
      now,
    ).catch((err) =>
      console.error("[memory_write] Typesense indexing failed:", err),
    );

    // Invalidate semantic cache — memory changed, so cached responses may be stale
    invalidateSemanticCacheForAgent(ctx.agentId).catch(() => {});

    return { success: true, message: `Memory saved: [${params.category}] ${params.content}` };
  },
});
