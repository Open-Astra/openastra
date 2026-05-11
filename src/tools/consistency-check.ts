import { z } from "zod";
import { registerTool } from "./registry.js";
import { getPool } from "../config/postgres.js";

// ── consistency_check ───────────────────────────────────────────────
// Cross-tier memory consistency checker. Scans for contradictions
// between daily memory, profile, and graph tiers. Reports conflicts
// with remediation suggestions.

const ConsistencyCheckParams = z.object({
  action: z
    .enum(["scan", "resolve", "report", "auto_fix"])
    .describe("Action: scan for inconsistencies, resolve a specific conflict, get report, or auto-fix trivial issues"),
  conflict_id: z.string().optional().describe("Conflict ID to resolve (for resolve action)"),
  resolution: z
    .enum(["keep_newer", "keep_profile", "keep_daily", "merge", "delete_both"])
    .optional()
    .describe("Resolution strategy (for resolve action)"),
  depth: z
    .enum(["quick", "thorough", "deep"])
    .default("thorough")
    .describe("Scan depth: quick (profile only), thorough (profile + daily), deep (all tiers + graph)"),
});

registerTool({
  name: "consistency_check",
  description:
    "Cross-tier memory consistency checker. Scan for contradictions between daily memory, profile, and knowledge graph. Get conflict reports with remediation suggestions.",
  parameters: ConsistencyCheckParams,

  async execute(params, ctx) {
    const pool = getPool();

    switch (params.action) {
      case "scan": {
        const conflicts: ConsistencyConflict[] = [];

        // Level 1: Check profile internal consistency
        const { rows: profileRows } = await pool.query<{
          profile_data: {
            strategicNotes: string[];
            interests: string[];
            expertiseAreas: string[];
          };
        }>(
          "SELECT profile_data FROM memory_profiles WHERE user_id = $1",
          [ctx.uid],
        );

        if (profileRows.length > 0) {
          const profile = profileRows[0]!.profile_data;
          const notes = profile.strategicNotes ?? [];

          // Check for duplicate notes
          const seen = new Set<string>();
          for (const note of notes) {
            const normalized = note.toLowerCase().trim();
            if (seen.has(normalized)) {
              conflicts.push({
                type: "duplicate",
                tier1: "profile",
                tier2: "profile",
                content1: note,
                content2: note,
                severity: "low",
                suggestion: "Remove duplicate strategic note",
              });
            }
            seen.add(normalized);
          }

          // Check for contradicting notes
          for (let i = 0; i < notes.length; i++) {
            for (let j = i + 1; j < notes.length; j++) {
              if (areContradicting(notes[i]!, notes[j]!)) {
                conflicts.push({
                  type: "contradiction",
                  tier1: "profile",
                  tier2: "profile",
                  content1: notes[i]!,
                  content2: notes[j]!,
                  severity: "high",
                  suggestion: "Review contradicting strategic notes and resolve",
                });
              }
            }
          }
        }

        // Level 2: Check daily vs profile consistency
        if (params.depth !== "quick") {
          const { rows: dailyRows } = await pool.query<{
            date: string;
            entries: Array<{ content: string; category: string }>;
          }>(
            "SELECT date, entries FROM daily_memory WHERE user_id = $1 ORDER BY date DESC LIMIT 7",
            [ctx.uid],
          );

          if (profileRows.length > 0 && dailyRows.length > 0) {
            const profileNotes = new Set(
              (profileRows[0]!.profile_data.strategicNotes ?? []).map((n: string) => n.toLowerCase()),
            );

            for (const day of dailyRows) {
              for (const entry of day.entries) {
                if (entry.category === "decision" || entry.category === "strategy") {
                  // Check if daily decisions contradict profile notes
                  for (const note of profileNotes) {
                    if (areContradicting(entry.content, note)) {
                      conflicts.push({
                        type: "cross_tier_contradiction",
                        tier1: "daily",
                        tier2: "profile",
                        content1: `[${day.date}] ${entry.content}`,
                        content2: note,
                        severity: "medium",
                        suggestion: "Recent daily entry contradicts profile note — may need profile update",
                      });
                    }
                  }
                }
              }
            }
          }
        }

        // Level 3: Check graph consistency
        if (params.depth === "deep") {
          // Look for contradicting edges
          const { rows: contradictions } = await pool.query<{
            source_name: string;
            target_name: string;
            types: string[];
          }>(
            `SELECT
               s.name AS source_name,
               t.name AS target_name,
               array_agg(e.type) AS types
             FROM graph_edges e
             JOIN graph_entities s ON s.id = e.source_id AND s.uid = $1
             JOIN graph_entities t ON t.id = e.target_id AND t.uid = $1
             WHERE e.uid = $1
             GROUP BY s.name, t.name
             HAVING COUNT(DISTINCT e.type) > 1
               AND array_agg(e.type) && ARRAY['contradicts', 'supports']
             LIMIT 20`,
            [ctx.uid],
          );

          for (const row of contradictions) {
            if (row.types.includes("contradicts") && row.types.includes("supports")) {
              conflicts.push({
                type: "graph_contradiction",
                tier1: "graph",
                tier2: "graph",
                content1: `${row.source_name} → ${row.target_name} (supports)`,
                content2: `${row.source_name} → ${row.target_name} (contradicts)`,
                severity: "high",
                suggestion: "Entity has both supporting and contradicting edges — review relationship",
              });
            }
          }

          // Check for orphaned entities (no edges)
          const { rows: orphans } = await pool.query<{ name: string; type: string }>(
            `SELECT e.name, e.type FROM graph_entities e
             WHERE e.uid = $1
               AND NOT EXISTS (SELECT 1 FROM graph_edges ed WHERE ed.uid = $1 AND (ed.source_id = e.id OR ed.target_id = e.id))
               AND e.access_count <= 1
             LIMIT 20`,
            [ctx.uid],
          );

          for (const orphan of orphans) {
            conflicts.push({
              type: "orphan",
              tier1: "graph",
              tier2: "graph",
              content1: `${orphan.name} (${orphan.type})`,
              content2: "",
              severity: "low",
              suggestion: "Orphaned graph entity with no connections — consider pruning",
            });
          }
        }

        // Persist conflicts
        for (const conflict of conflicts) {
          await pool.query(
            `INSERT INTO memory_consistency_conflicts (uid, value, created_at)
             VALUES ($1, $2::jsonb, NOW())`,
            [ctx.uid, JSON.stringify(conflict)],
          ).catch(() => {});
        }

        return {
          result: `Scan complete: ${conflicts.length} issue(s) found`,
          depth: params.depth,
          summary: {
            contradictions: conflicts.filter((c) => c.type.includes("contradiction")).length,
            duplicates: conflicts.filter((c) => c.type === "duplicate").length,
            orphans: conflicts.filter((c) => c.type === "orphan").length,
            high: conflicts.filter((c) => c.severity === "high").length,
            medium: conflicts.filter((c) => c.severity === "medium").length,
            low: conflicts.filter((c) => c.severity === "low").length,
          },
          conflicts: conflicts.slice(0, 20),
        };
      }

      case "resolve": {
        if (!params.conflict_id || !params.resolution) {
          return { error: "conflict_id and resolution required" };
        }

        await pool.query(
          `UPDATE memory_consistency_conflicts
           SET value = value || $1::jsonb
           WHERE uid = $2 AND id = $3::uuid`,
          [
            JSON.stringify({ status: "resolved", resolution: params.resolution, resolvedAt: Date.now() }),
            ctx.uid,
            params.conflict_id,
          ],
        );

        return {
          result: "Conflict resolved",
          conflictId: params.conflict_id,
          resolution: params.resolution,
        };
      }

      case "report": {
        const { rows } = await pool.query<{
          total: string;
          high: string;
          medium: string;
          low: string;
          resolved: string;
        }>(
          `SELECT
             COUNT(*)::text AS total,
             COUNT(*) FILTER (WHERE value->>'severity' = 'high')::text AS high,
             COUNT(*) FILTER (WHERE value->>'severity' = 'medium')::text AS medium,
             COUNT(*) FILTER (WHERE value->>'severity' = 'low')::text AS low,
             COUNT(*) FILTER (WHERE value->>'status' = 'resolved')::text AS resolved
           FROM memory_consistency_conflicts WHERE uid = $1`,
          [ctx.uid],
        );

        return {
          result: "Consistency report",
          total: parseInt(rows[0]?.total ?? "0"),
          high: parseInt(rows[0]?.high ?? "0"),
          medium: parseInt(rows[0]?.medium ?? "0"),
          low: parseInt(rows[0]?.low ?? "0"),
          resolved: parseInt(rows[0]?.resolved ?? "0"),
        };
      }

      case "auto_fix": {
        // Auto-fix trivial issues: duplicates and orphans
        let fixed = 0;

        // Remove duplicate strategic notes
        const { rows: profileRows } = await pool.query<{
          profile_data: { strategicNotes: string[] };
        }>(
          "SELECT profile_data FROM memory_profiles WHERE user_id = $1",
          [ctx.uid],
        );

        if (profileRows.length > 0) {
          const notes = profileRows[0]!.profile_data.strategicNotes ?? [];
          const unique = [...new Set(notes)];
          if (unique.length < notes.length) {
            await pool.query(
              `UPDATE memory_profiles
               SET profile_data = jsonb_set(profile_data, '{strategicNotes}', $1::jsonb), updated_at = NOW()
               WHERE user_id = $2`,
              [JSON.stringify(unique), ctx.uid],
            );
            fixed += notes.length - unique.length;
          }
        }

        // Prune orphaned low-access graph entities
        const { rowCount } = await pool.query(
          `DELETE FROM graph_entities
           WHERE uid = $1
             AND access_count <= 1
             AND reinforcement_score < 0.2
             AND NOT EXISTS (
               SELECT 1 FROM graph_edges
               WHERE uid = $1 AND (source_id = graph_entities.id OR target_id = graph_entities.id)
             )`,
          [ctx.uid],
        );
        fixed += rowCount ?? 0;

        return {
          result: `Auto-fix complete: ${fixed} issue(s) resolved`,
          fixedCount: fixed,
        };
      }

      default:
        return { error: "Unknown action" };
    }
  },
});

interface ConsistencyConflict {
  type: string;
  tier1: string;
  tier2: string;
  content1: string;
  content2: string;
  severity: "high" | "medium" | "low";
  suggestion: string;
}

function areContradicting(text1: string, text2: string): boolean {
  const lower1 = text1.toLowerCase();
  const lower2 = text2.toLowerCase();

  // Check for explicit negation patterns
  const negationPairs = [
    [/\bshould\b/, /\bshould not\b/],
    [/\balways\b/, /\bnever\b/],
    [/\bincrease\b/, /\bdecrease\b/],
    [/\bbuy\b/, /\bsell\b/],
    [/\bbullish\b/, /\bbearish\b/],
    [/\bover\b/, /\bunder\b/],
    [/\btrue\b/, /\bfalse\b/],
    [/\bgood\b/, /\bbad\b/],
  ];

  for (const [pattern1, pattern2] of negationPairs) {
    if (
      (pattern1!.test(lower1) && pattern2!.test(lower2)) ||
      (pattern2!.test(lower1) && pattern1!.test(lower2))
    ) {
      // Also check that they share some common subject
      const words1 = new Set(lower1.split(/\s+/).filter((w) => w.length > 4));
      const words2 = new Set(lower2.split(/\s+/).filter((w) => w.length > 4));
      const overlap = [...words1].filter((w) => words2.has(w));
      if (overlap.length >= 2) return true;
    }
  }

  return false;
}
