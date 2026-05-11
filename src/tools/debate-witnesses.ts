import { z } from "zod";
import { registerTool } from "./registry.js";
import { getPool } from "../config/postgres.js";

// ── debate_witness ──────────────────────────────────────────────────
// Evidence retrieval from memory tiers for debates. During swarm
// conflict mediation, this tool pulls relevant memory evidence to
// support or refute positions, with citation formatting.

const DebateWitnessParams = z.object({
  action: z
    .enum(["gather_evidence", "cite", "summarize_evidence", "cross_reference"])
    .describe("Action: gather evidence for a claim, cite a memory, summarize available evidence, or cross-reference claims"),
  claim: z.string().optional().describe("The claim to find evidence for/against"),
  swarm_id: z.string().optional().describe("Swarm ID for blackboard context"),
  tiers: z
    .array(z.enum(["daily", "profile", "graph", "session"]))
    .default(["daily", "graph"])
    .describe("Which memory tiers to search for evidence"),
  max_evidence: z.number().default(10).describe("Maximum evidence items to return"),
  memory_id: z.string().optional().describe("Specific memory entry ID to cite (for cite action)"),
});

registerTool({
  name: "debate_witness",
  description:
    "Evidence retrieval for agent debates. Gather supporting/contradicting evidence from memory tiers, format citations, and cross-reference claims across memories.",
  parameters: DebateWitnessParams,

  async execute(params, ctx) {
    const pool = getPool();

    switch (params.action) {
      case "gather_evidence": {
        if (!params.claim) return { error: "claim required for gather_evidence" };

        const evidence: EvidenceItem[] = [];

        // Search daily memory
        if (params.tiers.includes("daily")) {
          const { rows } = await pool.query<{
            date: string;
            entries: Array<{ content: string; category: string; timestamp: number }>;
          }>(
            `SELECT date, entries FROM daily_memory
             WHERE user_id = $1 ORDER BY date DESC LIMIT 14`,
            [ctx.uid],
          );

          for (const row of rows) {
            for (const entry of row.entries) {
              const relevance = computeRelevance(params.claim, entry.content);
              if (relevance > 0.3) {
                evidence.push({
                  tier: "daily",
                  content: entry.content,
                  relevance,
                  date: row.date,
                  category: entry.category,
                  citation: `[Daily Memory ${row.date}/${entry.category}]`,
                });
              }
            }
          }
        }

        // Search graph entities
        if (params.tiers.includes("graph")) {
          const claimWords = params.claim.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
          const searchTerms = claimWords.slice(0, 5).join(" | ");

          if (searchTerms) {
            const { rows: entities } = await pool.query<{
              id: string;
              name: string;
              description: string;
              type: string;
              reinforcement_score: number;
            }>(
              `SELECT id, name, description, type, reinforcement_score
               FROM graph_entities
               WHERE uid = $1 AND (
                 name ILIKE ANY($2) OR description ILIKE ANY($2)
               )
               ORDER BY reinforcement_score DESC LIMIT $3`,
              [ctx.uid, claimWords.map((w) => `%${w}%`), params.max_evidence],
            );

            for (const entity of entities) {
              const relevance = computeRelevance(params.claim, `${entity.name}: ${entity.description}`);
              if (relevance > 0.2) {
                evidence.push({
                  tier: "graph",
                  content: `${entity.name} (${entity.type}): ${entity.description}`,
                  relevance,
                  entityId: entity.id,
                  citation: `[Graph Entity: ${entity.name} (${entity.type})]`,
                });
              }
            }
          }
        }

        // Search profile
        if (params.tiers.includes("profile")) {
          const { rows: profileRows } = await pool.query<{
            profile_data: { strategicNotes: string[] };
          }>(
            "SELECT profile_data FROM memory_profiles WHERE user_id = $1",
            [ctx.uid],
          );

          if (profileRows.length > 0) {
            const notes = profileRows[0]!.profile_data.strategicNotes ?? [];
            for (const note of notes) {
              const relevance = computeRelevance(params.claim, note);
              if (relevance > 0.3) {
                evidence.push({
                  tier: "profile",
                  content: note,
                  relevance,
                  citation: "[Profile Strategic Note]",
                });
              }
            }
          }
        }

        // Sort by relevance and limit
        evidence.sort((a, b) => b.relevance - a.relevance);
        const topEvidence = evidence.slice(0, params.max_evidence);

        // Classify evidence as supporting or contradicting
        const claim = params.claim!;
        const supporting = topEvidence.filter((e) => !isContradicting(claim, e.content));
        const contradicting = topEvidence.filter((e) => isContradicting(claim, e.content));

        return {
          result: `${topEvidence.length} evidence item(s) found`,
          claim: params.claim,
          supporting: supporting.map(formatEvidence),
          contradicting: contradicting.map(formatEvidence),
          totalSearched: evidence.length,
        };
      }

      case "cite": {
        if (!params.memory_id) return { error: "memory_id required for cite" };

        // Try to find in graph entities
        const { rows: entityRows } = await pool.query<{
          name: string;
          description: string;
          type: string;
          created_at: string;
        }>(
          "SELECT name, description, type, created_at FROM graph_entities WHERE id = $1::uuid AND uid = $2",
          [params.memory_id, ctx.uid],
        );

        if (entityRows.length > 0) {
          const entity = entityRows[0]!;
          return {
            result: "Citation generated",
            citation: `[Graph Entity: ${entity.name} (${entity.type}), created ${entity.created_at}]`,
            content: entity.description,
            source: "graph",
          };
        }

        return { error: "Memory entry not found" };
      }

      case "summarize_evidence": {
        if (!params.claim) return { error: "claim required" };

        // Quick scan across tiers
        const evidenceCounts: Record<string, number> = {};

        for (const tier of params.tiers) {
          switch (tier) {
            case "daily": {
              const { rows } = await pool.query<{ count: string }>(
                `SELECT COUNT(*)::text AS count FROM daily_memory WHERE user_id = $1`,
                [ctx.uid],
              );
              evidenceCounts.daily = parseInt(rows[0]?.count ?? "0");
              break;
            }
            case "graph": {
              const { rows } = await pool.query<{ count: string }>(
                "SELECT COUNT(*)::text AS count FROM graph_entities WHERE uid = $1",
                [ctx.uid],
              );
              evidenceCounts.graph = parseInt(rows[0]?.count ?? "0");
              break;
            }
            case "profile": {
              evidenceCounts.profile = 1;
              break;
            }
          }
        }

        return {
          result: "Evidence summary",
          claim: params.claim,
          availableEvidence: evidenceCounts,
          recommendation: "Use gather_evidence for detailed results with relevance scoring",
        };
      }

      case "cross_reference": {
        if (!params.claim) return { error: "claim required" };

        // Check if the claim is consistent across tiers
        const dailyEvidence: string[] = [];
        const graphEvidence: string[] = [];
        const profileEvidence: string[] = [];

        // Sample from each tier
        const { rows: dailyRows } = await pool.query<{
          entries: Array<{ content: string }>;
        }>(
          "SELECT entries FROM daily_memory WHERE user_id = $1 ORDER BY date DESC LIMIT 7",
          [ctx.uid],
        );
        for (const row of dailyRows) {
          for (const entry of row.entries) {
            if (computeRelevance(params.claim, entry.content) > 0.4) {
              dailyEvidence.push(entry.content.slice(0, 200));
            }
          }
        }

        const { rows: entityRows } = await pool.query<{
          name: string;
          description: string;
        }>(
          `SELECT name, description FROM graph_entities
           WHERE uid = $1 ORDER BY reinforcement_score DESC LIMIT 20`,
          [ctx.uid],
        );
        for (const entity of entityRows) {
          if (computeRelevance(params.claim, `${entity.name} ${entity.description}`) > 0.3) {
            graphEvidence.push(`${entity.name}: ${entity.description}`.slice(0, 200));
          }
        }

        const { rows: profileRows } = await pool.query<{
          profile_data: { strategicNotes: string[] };
        }>(
          "SELECT profile_data FROM memory_profiles WHERE user_id = $1",
          [ctx.uid],
        );
        if (profileRows.length > 0) {
          for (const note of profileRows[0]!.profile_data.strategicNotes ?? []) {
            if (computeRelevance(params.claim, note) > 0.3) {
              profileEvidence.push(note.slice(0, 200));
            }
          }
        }

        const tiersWithEvidence = [
          dailyEvidence.length > 0 ? "daily" : null,
          graphEvidence.length > 0 ? "graph" : null,
          profileEvidence.length > 0 ? "profile" : null,
        ].filter(Boolean);

        return {
          result: "Cross-reference complete",
          claim: params.claim,
          consistency: tiersWithEvidence.length >= 2 ? "consistent" : "insufficient",
          tiersWithEvidence,
          dailyEvidence: dailyEvidence.slice(0, 3),
          graphEvidence: graphEvidence.slice(0, 3),
          profileEvidence: profileEvidence.slice(0, 3),
        };
      }

      default:
        return { error: "Unknown action" };
    }
  },
});

interface EvidenceItem {
  tier: string;
  content: string;
  relevance: number;
  date?: string;
  category?: string;
  entityId?: string;
  citation: string;
}

function formatEvidence(item: EvidenceItem) {
  return {
    citation: item.citation,
    content: item.content.slice(0, 500),
    relevance: Math.round(item.relevance * 100) / 100,
    tier: item.tier,
  };
}

function computeRelevance(claim: string, content: string): number {
  const claimWords = new Set(claim.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
  const contentWords = new Set(content.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
  const intersection = new Set([...claimWords].filter((w) => contentWords.has(w)));
  return claimWords.size > 0 ? intersection.size / claimWords.size : 0;
}

function isContradicting(claim: string, content: string): boolean {
  const negators = /\b(?:not|never|no|false|incorrect|wrong|disagree|contrary|opposite|however|but)\b/i;
  const claimWords = claim.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  const hasOverlap = claimWords.some((w) => content.toLowerCase().includes(w));
  return hasOverlap && negators.test(content);
}
