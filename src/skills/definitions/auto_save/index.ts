import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { appendDailyMemory, getDailyEntryCount } from "../../../memory/store.js";
import { indexDailyEntry } from "../../../memory/indexer.js";
import { extractEntityMentions, findOrCreateEntity, createEdge } from "../../../memory/graph.js";

// ── Auto-Save Skill ───────────────────────────────────────────────
// Provides tools for automatic fact extraction from conversation
// turns. The agent calls `auto_extract_facts` after meaningful
// exchanges to save key information to daily memory and graph
// without requiring explicit memory_write calls.
//
// Also provides `auto_save_summary` for end-of-conversation
// summaries that persist the session's key takeaways.

const ExtractFactsParams = z.object({
  text: z.string().describe("Conversation text to extract facts from"),
  categories: z
    .array(z.enum(["decision", "outcome", "strategy", "note", "interaction"]))
    .optional()
    .describe("Categories to extract (default: all)"),
});

const SaveSummaryParams = z.object({
  summary: z.string().describe("Summary of the conversation or session"),
  keyFacts: z.array(z.string()).optional().describe("Individual facts worth remembering"),
  entities: z
    .array(
      z.object({
        name: z.string(),
        type: z.enum(["person", "team", "event", "concept", "market", "outcome", "document"]),
        description: z.string().optional(),
      }),
    )
    .optional()
    .describe("Entities mentioned that should be added to the knowledge graph"),
});

const autoSaveSkill: SkillDefinition = {
  name: "auto_save",
  version: "1.0.0",

  manifest: {
    id: "auto_save",
    name: "Auto Save",
    description: "Automatic fact extraction and end-of-turn saving. Extracts entities, decisions, and outcomes from conversation text into memory and knowledge graph.",
    category: "execute",
    tools: ["auto_extract_facts", "auto_save_summary"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "auto_extract_facts",
      description: "Extract and save facts from conversation text. Automatically identifies entities, decisions, and key information, saving them to daily memory and the knowledge graph.",
      parameters: ExtractFactsParams,

      async execute(params, toolCtx) {
        const uid = toolCtx.uid;
        const allowedCategories = new Set(
          params.categories ?? ["decision", "outcome", "strategy", "note", "interaction"],
        );
        const today = new Date().toISOString().slice(0, 10);
        const saved: Array<{ category: string; content: string }> = [];

        // Extract entity mentions and add to graph
        const mentions = extractEntityMentions(params.text);
        const graphEntities: string[] = [];

        for (const mention of mentions) {
          try {
            const entity = await findOrCreateEntity(uid, mention.type, mention.name, "");
            graphEntities.push(`${mention.type}:${mention.name} (${entity.id})`);
          } catch {
            // Graph unavailable — continue without it
          }
        }

        // Extract sentences that look like decisions or outcomes
        const sentences = params.text
          .split(/[.!?\n]+/)
          .map((s) => s.trim())
          .filter((s) => s.length > 15);

        const DECISION_SIGNALS = [
          "decided", "going with", "betting on", "picking", "choosing",
          "will take", "locking in", "let's go", "i'll take",
        ];
        const OUTCOME_SIGNALS = [
          "won", "lost", "hit", "missed", "cashed", "busted",
          "covered", "pushed", "result was",
        ];
        const STRATEGY_SIGNALS = [
          "pattern", "trend", "always", "never", "when the",
          "correlation", "edge", "value", "strategy", "approach",
        ];

        for (const sentence of sentences) {
          const lower = sentence.toLowerCase();

          if (allowedCategories.has("decision") && DECISION_SIGNALS.some((s) => lower.includes(s))) {
            const entry = { timestamp: Date.now(), category: "decision" as const, content: sentence };
            const count = await getDailyEntryCount(uid, today);
            await appendDailyMemory(uid, entry);
            indexDailyEntry(uid, today, count, "decision", sentence, Date.now()).catch(() => {});
            saved.push({ category: "decision", content: sentence });
          } else if (allowedCategories.has("outcome") && OUTCOME_SIGNALS.some((s) => lower.includes(s))) {
            const entry = { timestamp: Date.now(), category: "outcome" as const, content: sentence };
            const count = await getDailyEntryCount(uid, today);
            await appendDailyMemory(uid, entry);
            indexDailyEntry(uid, today, count, "outcome", sentence, Date.now()).catch(() => {});
            saved.push({ category: "outcome", content: sentence });
          } else if (allowedCategories.has("strategy") && STRATEGY_SIGNALS.some((s) => lower.includes(s))) {
            const entry = { timestamp: Date.now(), category: "strategy" as const, content: sentence };
            const count = await getDailyEntryCount(uid, today);
            await appendDailyMemory(uid, entry);
            indexDailyEntry(uid, today, count, "strategy", sentence, Date.now()).catch(() => {});
            saved.push({ category: "strategy", content: sentence });
          }
        }

        return {
          success: true,
          factsSaved: saved.length,
          facts: saved,
          entitiesFound: graphEntities.length,
          entities: graphEntities,
        };
      },
    });

    ctx.registerTool({
      name: "auto_save_summary",
      description: "Save a conversation summary and key facts to memory. Use at the end of meaningful conversations to ensure important information persists.",
      parameters: SaveSummaryParams,

      async execute(params, toolCtx) {
        const uid = toolCtx.uid;
        const today = new Date().toISOString().slice(0, 10);
        let savedCount = 0;

        // Save the summary as a note
        const summaryEntry = {
          timestamp: Date.now(),
          category: "note" as const,
          content: `[Session Summary] ${params.summary}`,
        };
        const count = await getDailyEntryCount(uid, today);
        await appendDailyMemory(uid, summaryEntry);
        indexDailyEntry(uid, today, count, "note", summaryEntry.content, Date.now()).catch(() => {});
        savedCount++;

        // Save individual facts
        if (params.keyFacts) {
          for (const fact of params.keyFacts) {
            const factEntry = {
              timestamp: Date.now(),
              category: "note" as const,
              content: fact,
            };
            const idx = await getDailyEntryCount(uid, today);
            await appendDailyMemory(uid, factEntry);
            indexDailyEntry(uid, today, idx, "note", fact, Date.now()).catch(() => {});
            savedCount++;
          }
        }

        // Add entities to graph
        const entityResults: string[] = [];
        if (params.entities) {
          for (const ent of params.entities) {
            try {
              const entity = await findOrCreateEntity(
                uid,
                ent.type,
                ent.name,
                ent.description ?? "",
              );
              entityResults.push(`${ent.type}:${ent.name} (${entity.id})`);
            } catch {
              // Graph unavailable
            }
          }

          // Create edges between co-mentioned entities
          if (entityResults.length > 1 && params.entities.length > 1) {
            const entityIds = entityResults.map((e) => e.match(/\((.+)\)/)?.[1]).filter(Boolean) as string[];
            for (let i = 0; i < entityIds.length - 1; i++) {
              for (let j = i + 1; j < entityIds.length; j++) {
                createEdge(uid, entityIds[i]!, entityIds[j]!, "related_to", 0.5).catch(() => {});
              }
            }
          }
        }

        return {
          success: true,
          savedCount,
          entitiesAdded: entityResults.length,
          entities: entityResults,
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "auto_save",
      instructions:
        "You have automatic fact extraction tools. Call `auto_extract_facts` with conversation text to automatically identify and save decisions, outcomes, strategies, and entity mentions. Call `auto_save_summary` at the end of important conversations to persist a summary and key facts. Use these proactively after meaningful exchanges.",
    };
  },
};

export default autoSaveSkill;
