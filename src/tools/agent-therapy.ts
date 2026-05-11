import { z } from "zod";
import { randomUUID } from "node:crypto";
import { registerTool } from "./registry.js";
import { getPool } from "../config/postgres.js";

// ── agent_therapy ───────────────────────────────────────────────────
// Agent "therapy" / reflection journal. Tracks emotional state,
// failure patterns, and provides structured therapeutic reflection
// loops for agents to improve through self-analysis.

const AgentTherapyParams = z.object({
  action: z
    .enum(["reflect", "journal", "mood", "patterns", "session_review"])
    .describe("Action: structured reflection, write journal entry, track mood, analyze failure patterns, or review past sessions"),
  entry: z.string().optional().describe("Journal entry text (for journal action)"),
  mood: z
    .enum(["confident", "uncertain", "frustrated", "curious", "accomplished", "overwhelmed"])
    .optional()
    .describe("Current emotional state (for mood action)"),
  trigger: z.string().optional().describe("What triggered this reflection"),
  session_id: z.string().optional().describe("Session to review (for session_review)"),
});

registerTool({
  name: "agent_therapy",
  description:
    "Agent self-reflection and therapy system. Track emotional states, maintain a failure/success journal, analyze behavioral patterns, and run structured reflection loops for continuous improvement.",
  parameters: AgentTherapyParams,

  async execute(params, ctx) {
    const pool = getPool();

    switch (params.action) {
      case "reflect": {
        // Structured reflection: pull recent failures and successes, generate insights
        const { rows: recentEntries } = await pool.query<{
          value: { type: string; content: string; mood: string; timestamp: number };
        }>(
          `SELECT value FROM agent_therapy_journal
           WHERE uid = $1 AND agent_id = $2
           ORDER BY created_at DESC LIMIT 20`,
          [ctx.uid, ctx.agentId],
        );

        const failures = recentEntries.filter((r) => r.value.type === "failure");
        const successes = recentEntries.filter((r) => r.value.type === "success");
        const moods = recentEntries.filter((r) => r.value.mood).map((r) => r.value.mood);

        // Identify patterns
        const moodCounts: Record<string, number> = {};
        for (const mood of moods) {
          moodCounts[mood] = (moodCounts[mood] ?? 0) + 1;
        }

        const dominantMood = Object.entries(moodCounts).sort((a, b) => b[1] - a[1])[0];
        const failureRate = recentEntries.length > 0
          ? Math.round((failures.length / recentEntries.length) * 100)
          : 0;

        const reflection = {
          totalEntries: recentEntries.length,
          successCount: successes.length,
          failureCount: failures.length,
          failureRate: `${failureRate}%`,
          dominantMood: dominantMood ? dominantMood[0] : "neutral",
          recentFailures: failures.slice(0, 3).map((f) => f.value.content.slice(0, 200)),
          recentSuccesses: successes.slice(0, 3).map((s) => s.value.content.slice(0, 200)),
          insights: generateInsights(failures.length, successes.length, dominantMood?.[0]),
        };

        // Log the reflection
        await pool.query(
          `INSERT INTO agent_therapy_journal (id, uid, agent_id, value, created_at)
           VALUES ($1, $2, $3, $4::jsonb, NOW())`,
          [randomUUID(), ctx.uid, ctx.agentId, JSON.stringify({
            type: "reflection",
            content: JSON.stringify(reflection),
            mood: dominantMood?.[0] ?? "neutral",
            trigger: params.trigger ?? "scheduled",
            timestamp: Date.now(),
          })],
        );

        return { result: "Reflection complete", reflection };
      }

      case "journal": {
        if (!params.entry) return { error: "entry required for journal action" };

        const entryType = categorizeEntry(params.entry);
        const id = randomUUID();

        await pool.query(
          `INSERT INTO agent_therapy_journal (id, uid, agent_id, value, created_at)
           VALUES ($1, $2, $3, $4::jsonb, NOW())`,
          [id, ctx.uid, ctx.agentId, JSON.stringify({
            type: entryType,
            content: params.entry,
            mood: params.mood ?? "neutral",
            trigger: params.trigger ?? "manual",
            timestamp: Date.now(),
          })],
        );

        return {
          result: "Journal entry recorded",
          entryId: id,
          type: entryType,
          mood: params.mood ?? "neutral",
        };
      }

      case "mood": {
        if (!params.mood) return { error: "mood required for mood action" };

        const id = randomUUID();
        await pool.query(
          `INSERT INTO agent_therapy_journal (id, uid, agent_id, value, created_at)
           VALUES ($1, $2, $3, $4::jsonb, NOW())`,
          [id, ctx.uid, ctx.agentId, JSON.stringify({
            type: "mood",
            content: `Mood: ${params.mood}${params.trigger ? ` — triggered by: ${params.trigger}` : ""}`,
            mood: params.mood,
            trigger: params.trigger ?? "check-in",
            timestamp: Date.now(),
          })],
        );

        // Get mood trend
        const { rows: moodHistory } = await pool.query<{
          value: { mood: string; timestamp: number };
        }>(
          `SELECT value FROM agent_therapy_journal
           WHERE uid = $1 AND agent_id = $2 AND value->>'type' = 'mood'
           ORDER BY created_at DESC LIMIT 10`,
          [ctx.uid, ctx.agentId],
        );

        const trend = moodHistory.map((r) => r.value.mood);

        return {
          result: "Mood recorded",
          currentMood: params.mood,
          moodTrend: trend,
        };
      }

      case "patterns": {
        const { rows } = await pool.query<{
          value: { type: string; content: string; mood: string; trigger: string; timestamp: number };
        }>(
          `SELECT value FROM agent_therapy_journal
           WHERE uid = $1 AND agent_id = $2
           ORDER BY created_at DESC LIMIT 100`,
          [ctx.uid, ctx.agentId],
        );

        // Analyze patterns
        const typeCounts: Record<string, number> = {};
        const moodCounts: Record<string, number> = {};
        const triggerCounts: Record<string, number> = {};
        const failureKeywords: Record<string, number> = {};

        for (const row of rows) {
          typeCounts[row.value.type] = (typeCounts[row.value.type] ?? 0) + 1;
          if (row.value.mood) moodCounts[row.value.mood] = (moodCounts[row.value.mood] ?? 0) + 1;
          if (row.value.trigger) triggerCounts[row.value.trigger] = (triggerCounts[row.value.trigger] ?? 0) + 1;

          if (row.value.type === "failure") {
            const words = row.value.content.toLowerCase().split(/\s+/);
            for (const word of words) {
              if (word.length > 4) {
                failureKeywords[word] = (failureKeywords[word] ?? 0) + 1;
              }
            }
          }
        }

        const topFailureKeywords = Object.entries(failureKeywords)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([word, count]) => ({ word, count }));

        return {
          result: "Pattern analysis complete",
          totalEntries: rows.length,
          byType: typeCounts,
          byMood: moodCounts,
          byTrigger: triggerCounts,
          commonFailureThemes: topFailureKeywords,
        };
      }

      case "session_review": {
        const { rows } = await pool.query<{
          value: { type: string; content: string; mood: string; timestamp: number };
        }>(
          `SELECT value FROM agent_therapy_journal
           WHERE uid = $1 AND agent_id = $2
           ORDER BY created_at DESC LIMIT 10`,
          [ctx.uid, ctx.agentId],
        );

        return {
          result: `${rows.length} recent journal entries`,
          entries: rows.map((r) => ({
            type: r.value.type,
            mood: r.value.mood,
            content: r.value.content.slice(0, 300),
            timestamp: r.value.timestamp,
          })),
        };
      }

      default:
        return { error: "Unknown action" };
    }
  },
});

function categorizeEntry(content: string): string {
  const lower = content.toLowerCase();
  if (/\b(?:fail|error|bug|crash|wrong|broke|issue|problem)\b/.test(lower)) return "failure";
  if (/\b(?:success|complete|done|fixed|resolved|achieved|win)\b/.test(lower)) return "success";
  if (/\b(?:learn|discover|realize|insight|understand)\b/.test(lower)) return "learning";
  return "note";
}

function generateInsights(failures: number, successes: number, dominantMood?: string): string[] {
  const insights: string[] = [];

  if (failures > successes * 2) {
    insights.push("High failure rate detected. Consider breaking tasks into smaller steps.");
  }
  if (successes > failures * 2) {
    insights.push("Strong success rate. Current approach is working well.");
  }
  if (dominantMood === "frustrated") {
    insights.push("Frustration pattern detected. Consider requesting clarification earlier in tasks.");
  }
  if (dominantMood === "overwhelmed") {
    insights.push("Overwhelm detected. Prioritize tasks and delegate where possible.");
  }
  if (dominantMood === "confident") {
    insights.push("Confidence is high. Good time to tackle challenging tasks.");
  }
  if (failures === 0 && successes === 0) {
    insights.push("No data yet. Start journaling to build a pattern baseline.");
  }

  return insights;
}
