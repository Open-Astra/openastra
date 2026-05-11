import { getPool } from "../config/postgres.js";
import type { InferenceClient } from "../inference/types.js";
import { loadProfile, updateProfile, loadRecentDailyMemory } from "./store.js";
import { createLogger } from "../utils/logger.js";
import type { DailyMemoryEntry, MemoryProfile } from "./types.js";

// ── Daily/Weekly Memory Summarization → Long-Term Profile ───────────
// Scheduled jobs that summarize recent memory into progressively
// more abstract representations:
//
//   Daily: raw entries → categorized summary
//   Weekly: daily summaries → strategic themes + profile updates
//   Monthly: weekly themes → long-term profile evolution
//
// Each level feeds into the next. Profile updates are non-destructive:
// new insights are appended, not overwritten.

const log = createLogger("summarizer");

// ── Types ───────────────────────────────────────────────────────────

export interface SummarizationResult {
  uid: string;
  period: "daily" | "weekly" | "monthly";
  summary: string;
  keyInsights: string[];
  profileUpdates: Partial<MemoryProfile>;
  entitiesMentioned: string[];
  topicsDiscovered: string[];
  timestamp: number;
}

// ── Daily Summarization ─────────────────────────────────────────────

/**
 * Summarize today's memory entries into a structured daily summary.
 * Runs at end of day (configurable via dailyResetHour).
 */
export async function runDailySummary(
  uid: string,
  inferenceClient: InferenceClient,
): Promise<SummarizationResult | null> {
  const entries = await loadRecentDailyMemory(uid);
  if (!entries || entries.length === 0) return null;

  // Flatten all entries from today and yesterday
  const allEntries: DailyMemoryEntry[] = [];
  for (const doc of entries) {
    if (Array.isArray(doc.entries)) {
      allEntries.push(...doc.entries);
    }
  }

  if (allEntries.length < 3) return null; // too few entries to summarize

  const response = await inferenceClient.chat({
    messages: [
      {
        role: "system",
        content: `Summarize the user's day from their memory entries. Extract key insights and identify topics.

Respond in JSON:
{
  "summary": "2-3 sentence summary of the day",
  "keyInsights": ["insight1", "insight2"],
  "topics": ["topic1", "topic2"],
  "entities": ["person/team/concept mentioned"],
  "profileUpdates": {
    "interests": ["newly discovered interests"],
    "expertiseAreas": ["demonstrated expertise"],
    "strategicNotes": ["important strategic insights"]
  }
}`,
      },
      {
        role: "user",
        content: `Memory entries:\n${allEntries.map((e) => `[${e.category}] ${e.content}`).join("\n")}`,
      },
    ],
    temperature: 0.3,
    maxTokens: 1000,
  });

  try {
    const content = response.content ?? "{}";
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as {
      summary?: string;
      keyInsights?: string[];
      topics?: string[];
      entities?: string[];
      profileUpdates?: Partial<MemoryProfile>;
    };

    const result: SummarizationResult = {
      uid,
      period: "daily",
      summary: parsed.summary ?? "",
      keyInsights: parsed.keyInsights ?? [],
      profileUpdates: parsed.profileUpdates ?? {},
      entitiesMentioned: parsed.entities ?? [],
      topicsDiscovered: parsed.topics ?? [],
      timestamp: Date.now(),
    };

    // Persist the daily summary
    await persistSummary(uid, result);

    log.info(`Daily summary for ${uid}: ${result.keyInsights.length} insights, ${result.topicsDiscovered.length} topics`);
    return result;
  } catch {
    return null;
  }
}

// ── Weekly Summarization ────────────────────────────────────────────

/**
 * Summarize the past week's daily summaries into strategic themes.
 * Runs weekly (Sunday midnight by default).
 */
export async function runWeeklySummary(
  uid: string,
  inferenceClient: InferenceClient,
): Promise<SummarizationResult | null> {
  const pool = getPool();

  // Load the past 7 daily summaries
  const { rows } = await pool.query<{ config: SummarizationResult }>(
    `SELECT config FROM memory_summaries
     WHERE user_id = $1 AND period = 'daily'
       AND created_at > NOW() - INTERVAL '7 days'
     ORDER BY created_at ASC`,
    [uid],
  );

  if (rows.length < 3) return null; // need at least 3 days

  const dailySummaries = rows.map((r) => r.config);

  // Load user profile for context
  const profile = await loadProfile(uid);

  const response = await inferenceClient.chat({
    messages: [
      {
        role: "system",
        content: `Analyze a week of daily summaries and extract strategic patterns.

Current user profile context:
${profile ? JSON.stringify({ interests: profile.interests, expertise: profile.expertiseAreas }, null, 2) : "No profile yet"}

Respond in JSON:
{
  "summary": "Week-in-review (3-4 sentences)",
  "keyInsights": ["strategic insight 1", "strategic insight 2"],
  "topics": ["recurring topic 1", "recurring topic 2"],
  "entities": ["key entities this week"],
  "profileUpdates": {
    "interests": ["updated interests based on this week"],
    "expertiseAreas": ["demonstrated/growing expertise"],
    "strategicNotes": ["strategic notes worth remembering long-term"],
    "communicationStyle": "observed communication style (if notable)"
  }
}`,
      },
      {
        role: "user",
        content: `This week's daily summaries:\n${dailySummaries.map((s, i) => `Day ${i + 1}: ${s.summary}\nInsights: ${s.keyInsights.join(", ")}`).join("\n\n")}`,
      },
    ],
    temperature: 0.3,
    maxTokens: 1500,
  });

  try {
    const content = response.content ?? "{}";
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as {
      summary?: string;
      keyInsights?: string[];
      topics?: string[];
      entities?: string[];
      profileUpdates?: Partial<MemoryProfile>;
    };

    const result: SummarizationResult = {
      uid,
      period: "weekly",
      summary: parsed.summary ?? "",
      keyInsights: parsed.keyInsights ?? [],
      profileUpdates: parsed.profileUpdates ?? {},
      entitiesMentioned: parsed.entities ?? [],
      topicsDiscovered: parsed.topics ?? [],
      timestamp: Date.now(),
    };

    // Apply profile updates
    if (result.profileUpdates && Object.keys(result.profileUpdates).length > 0) {
      const existing: Partial<MemoryProfile> = profile ?? {};
      const merged: Partial<MemoryProfile> = { ...result.profileUpdates };

      // Merge arrays (append unique items)
      if (merged.interests) {
        merged.interests = [...new Set([...(existing.interests ?? []), ...merged.interests])].slice(0, 20);
      }
      if (merged.expertiseAreas) {
        merged.expertiseAreas = [...new Set([...(existing.expertiseAreas ?? []), ...merged.expertiseAreas])].slice(0, 15);
      }
      if (merged.strategicNotes) {
        merged.strategicNotes = [...new Set([...(existing.strategicNotes ?? []), ...merged.strategicNotes])].slice(0, 30);
      }

      await updateProfile(uid, merged);
    }

    await persistSummary(uid, result);

    log.info(`Weekly summary for ${uid}: ${result.keyInsights.length} insights, profile updated`);
    return result;
  } catch {
    return null;
  }
}

// ── Full Consolidation Scheduler ────────────────────────────────────

/**
 * Run the appropriate summarization based on the day of the week.
 * Called by the cron scheduler.
 */
export async function runScheduledSummarization(
  uid: string,
  inferenceClient: InferenceClient,
): Promise<void> {
  const dayOfWeek = new Date().getDay(); // 0 = Sunday

  // Daily summary runs every day
  await runDailySummary(uid, inferenceClient).catch((err) => {
    log.error(`Daily summary failed for ${uid}:`, err);
  });

  // Weekly summary runs on Sundays
  if (dayOfWeek === 0) {
    await runWeeklySummary(uid, inferenceClient).catch((err) => {
      log.error(`Weekly summary failed for ${uid}:`, err);
    });
  }
}

// ── Persistence ─────────────────────────────────────────────────────

async function persistSummary(uid: string, result: SummarizationResult): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO memory_summaries (id, user_id, period, config, created_at)
     VALUES ($1, $2, $3, $4::jsonb, NOW())`,
    [randomUUID(), uid, result.period, JSON.stringify(result)],
  );
}

function randomUUID(): string {
  return crypto.randomUUID();
}

export async function getRecentSummaries(
  uid: string,
  period: "daily" | "weekly",
  limit: number = 5,
): Promise<SummarizationResult[]> {
  const pool = getPool();
  const { rows } = await pool.query<{ config: SummarizationResult }>(
    `SELECT config FROM memory_summaries
     WHERE user_id = $1 AND period = $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [uid, period, limit],
  );
  return rows.map((r) => r.config);
}
