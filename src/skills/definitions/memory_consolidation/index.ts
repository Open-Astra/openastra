import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import {
  consolidateDailyMemories,
  promoteRecurringThemes,
  decayAndPruneGraph,
  decayEdgeWeights,
  runConsolidation,
} from "../../../memory/consolidation.js";

// ── Memory Consolidation Trigger Skill ────────────────────────────
// Exposes the consolidation engine as on-demand tools so the agent
// can trigger rollups, theme promotion, and graph decay explicitly
// instead of waiting for the 4 AM cron.

const ConsolidateParams = z.object({
  daysOlderThan: z.number().min(1).max(90).optional().describe("Consolidate entries older than N days (default 7)"),
});

const PromoteThemesParams = z.object({
  daysToScan: z.number().min(1).max(60).optional().describe("Scan last N days for recurring themes (default 14)"),
});

const GraphDecayParams = z.object({
  decayFactor: z.number().min(0.5).max(1.0).optional().describe("Decay multiplier for stale entities (default 0.95)"),
  pruneThreshold: z.number().min(0).max(0.5).optional().describe("Remove entities below this score (default 0.01)"),
});

const memoryConsolidationSkill: SkillDefinition = {
  name: "memory_consolidation",
  version: "1.0.0",

  manifest: {
    id: "memory_consolidation",
    name: "Memory Consolidation",
    description: "On-demand memory consolidation: roll up old daily entries, promote recurring themes to profile, and decay stale graph entities.",
    category: "execute",
    tools: [
      "memory_consolidate_daily",
      "memory_promote_themes",
      "memory_decay_graph",
      "memory_consolidate_full",
    ],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "memory_consolidate_daily",
      description: "Consolidate old daily memory entries. Merges entries >N days old (default 7) by category into summaries to reduce storage and improve retrieval.",
      parameters: ConsolidateParams,

      async execute(params) {
        const days = params?.daysOlderThan ?? 7;
        const count = await consolidateDailyMemories(days);
        return {
          success: true,
          consolidatedRows: count,
          daysOlderThan: days,
          message: count > 0
            ? `Consolidated ${count} daily memory rows older than ${days} days.`
            : `No daily memory rows needed consolidation (threshold: ${days} days).`,
        };
      },
    });

    ctx.registerTool({
      name: "memory_promote_themes",
      description: "Scan recent daily memories for recurring strategy/decision themes and promote them to the user's long-term profile as strategic notes.",
      parameters: PromoteThemesParams,

      async execute(params) {
        const days = params?.daysToScan ?? 14;
        const count = await promoteRecurringThemes(days);
        return {
          success: true,
          promotedThemes: count,
          daysScanned: days,
          message: count > 0
            ? `Promoted ${count} recurring themes to long-term profile.`
            : `No new recurring themes found in the last ${days} days.`,
        };
      },
    });

    ctx.registerTool({
      name: "memory_decay_graph",
      description: "Apply temporal decay to stale graph entities and prune entities below threshold. Also decays edge weights on old connections.",
      parameters: GraphDecayParams,

      async execute(params) {
        const decay = params?.decayFactor ?? 0.95;
        const threshold = params?.pruneThreshold ?? 0.01;

        const [entityResult, edgeCount] = await Promise.all([
          decayAndPruneGraph(decay, threshold),
          decayEdgeWeights(),
        ]);

        return {
          success: true,
          entitiesDecayed: entityResult.decayed,
          entitiesPruned: entityResult.pruned,
          edgesDecayed: edgeCount,
          config: { decayFactor: decay, pruneThreshold: threshold },
        };
      },
    });

    ctx.registerTool({
      name: "memory_consolidate_full",
      description: "Run the full memory consolidation cycle: daily consolidation + theme promotion + graph decay + edge decay. Same as the nightly cron job.",
      parameters: z.object({}),

      async execute() {
        const start = Date.now();
        await runConsolidation();
        const elapsed = Date.now() - start;

        return {
          success: true,
          elapsedMs: elapsed,
          message: `Full consolidation cycle completed in ${elapsed}ms.`,
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "memory_consolidation",
      instructions:
        "You can trigger memory maintenance on demand: `memory_consolidate_daily` rolls up old entries, `memory_promote_themes` extracts recurring patterns into the profile, `memory_decay_graph` prunes stale knowledge graph entities, and `memory_consolidate_full` runs all of these together.",
    };
  },
};

export default memoryConsolidationSkill;
