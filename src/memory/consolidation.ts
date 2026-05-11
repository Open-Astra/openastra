import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";
import type { DailyMemoryEntry, MemoryProfile } from "./types.js";
import { updateProfile } from "./store.js";

// ── Memory Auto-Consolidation ───────────────────────────────────────
// Background job that runs daily to:
//  1. Summarize old daily memories (>7 days) into consolidated entries
//  2. Promote frequently recurring themes to long-term profile
//  3. Decay and prune low-value graph entities
//  4. Update reinforcement scores across the graph
//
// This keeps the memory system fresh and prevents unbounded growth
// while preserving important information in higher-tier storage.

const log = createLogger("consolidation");

// ── 1. Daily Memory Consolidation ──────────────────────────────────
// Entries older than 7 days get consolidated: multiple entries per day
// are merged into a single summary entry per category.

export async function consolidateDailyMemories(daysOlderThan: number = 7): Promise<number> {
  const pool = getPool();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysOlderThan);
  const cutoff = cutoffDate.toISOString().slice(0, 10);

  // Find daily memory rows with multiple entries that are old enough
  const { rows } = await pool.query<{
    user_id: string;
    date: string;
    entries: DailyMemoryEntry[];
  }>(
    `SELECT user_id, date, entries FROM daily_memory
     WHERE date < $1 AND jsonb_array_length(entries) > 3
     ORDER BY date ASC
     LIMIT 50`,
    [cutoff],
  );

  if (rows.length === 0) return 0;

  let consolidated = 0;

  for (const row of rows) {
    const entries = row.entries as DailyMemoryEntry[];
    if (entries.length <= 3) continue;

    // Group entries by category
    const byCategory = new Map<string, DailyMemoryEntry[]>();
    for (const entry of entries) {
      const list = byCategory.get(entry.category) ?? [];
      list.push(entry);
      byCategory.set(entry.category, list);
    }

    // Consolidate each category with >2 entries into a summary
    const consolidatedEntries: DailyMemoryEntry[] = [];

    for (const [category, catEntries] of byCategory) {
      if (catEntries.length <= 2) {
        // Keep as-is
        consolidatedEntries.push(...catEntries);
      } else {
        // Merge into a summary entry
        const contents = catEntries.map((e) => e.content);
        const summary = `[Consolidated ${catEntries.length} ${category} entries] ${contents.join(" | ")}`;

        consolidatedEntries.push({
          timestamp: catEntries[catEntries.length - 1]!.timestamp,
          category: category as DailyMemoryEntry["category"],
          content: summary.slice(0, 2000), // Cap at 2KB
          metadata: {
            consolidatedFrom: catEntries.length,
            originalTimestamps: catEntries.map((e) => e.timestamp),
          },
        });
      }
    }

    // Update the row with consolidated entries
    await pool.query(
      `UPDATE daily_memory SET entries = $1::jsonb, updated_at = NOW()
       WHERE user_id = $2 AND date = $3`,
      [JSON.stringify(consolidatedEntries), row.user_id, row.date],
    );

    consolidated++;
  }

  if (consolidated > 0) {
    log.info(`Consolidated ${consolidated} daily memory rows`);
  }

  return consolidated;
}

// ── 2. Theme Promotion to Profile ──────────────────────────────────
// Scans recent daily memories for recurring patterns and promotes
// them as strategic notes in the long-term profile.

export async function promoteRecurringThemes(daysToScan: number = 14): Promise<number> {
  const pool = getPool();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysToScan);
  const cutoff = cutoffDate.toISOString().slice(0, 10);

  // Get all users with recent daily memory
  const { rows: users } = await pool.query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM daily_memory WHERE date >= $1`,
    [cutoff],
  );

  let promoted = 0;

  for (const { user_id } of users) {
    // Collect all entries from the scan window
    const { rows: memRows } = await pool.query<{
      entries: DailyMemoryEntry[];
    }>(
      `SELECT entries FROM daily_memory
       WHERE user_id = $1 AND date >= $2
       ORDER BY date ASC`,
      [user_id, cutoff],
    );

    const allEntries: DailyMemoryEntry[] = [];
    for (const row of memRows) {
      allEntries.push(...(row.entries as DailyMemoryEntry[]));
    }

    if (allEntries.length < 5) continue;

    // Count strategy/decision entries — these are candidates for promotion
    const strategyEntries = allEntries.filter(
      (e) => e.category === "strategy" || e.category === "decision",
    );

    if (strategyEntries.length < 3) continue;

    // Extract common phrases (simple word frequency analysis)
    const wordFreq = new Map<string, number>();
    for (const entry of strategyEntries) {
      const words = entry.content.toLowerCase().split(/\s+/);
      // Extract 2-word and 3-word phrases
      for (let i = 0; i < words.length - 1; i++) {
        const bigram = `${words[i]} ${words[i + 1]}`;
        wordFreq.set(bigram, (wordFreq.get(bigram) ?? 0) + 1);
        if (i < words.length - 2) {
          const trigram = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
          wordFreq.set(trigram, (wordFreq.get(trigram) ?? 0) + 1);
        }
      }
    }

    // Find phrases that appear 3+ times (recurring themes)
    const recurring = [...wordFreq.entries()]
      .filter(([phrase, count]) => count >= 3 && phrase.length > 8)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);

    if (recurring.length === 0) continue;

    // Load existing profile to avoid duplicates
    const { rows: profileRows } = await pool.query<{ profile_data: MemoryProfile }>(
      "SELECT profile_data FROM memory_profiles WHERE user_id = $1",
      [user_id],
    );

    const existingNotes = new Set(
      (profileRows[0]?.profile_data as MemoryProfile | undefined)?.strategicNotes ?? [],
    );

    const newNotes: string[] = [];
    for (const [phrase, count] of recurring) {
      const note = `Recurring theme (${count}x in ${daysToScan}d): "${phrase}"`;
      if (!existingNotes.has(note)) {
        newNotes.push(note);
      }
    }

    if (newNotes.length > 0) {
      const existingProfile = profileRows[0]?.profile_data as MemoryProfile | undefined;
      await updateProfile(user_id, {
        strategicNotes: [
          ...(existingProfile?.strategicNotes ?? []),
          ...newNotes,
        ],
      });
      promoted += newNotes.length;
    }
  }

  if (promoted > 0) {
    log.info(`Promoted ${promoted} recurring themes to profiles`);
  }

  return promoted;
}

// ── 3. Graph Decay & Pruning ───────────────────────────────────────
// Reduces reinforcement scores on stale entities and removes entities
// that have decayed below threshold.

export async function decayAndPruneGraph(
  decayFactor: number = 0.95,
  pruneThreshold: number = 0.01,
): Promise<{ decayed: number; pruned: number }> {
  const pool = getPool();

  // Apply decay to all entities not accessed in 7+ days
  const decayResult = await pool.query(
    `UPDATE graph_entities
     SET reinforcement_score = reinforcement_score * $1
     WHERE last_accessed_at < NOW() - INTERVAL '7 days'
       AND reinforcement_score > $2
     RETURNING id`,
    [decayFactor, pruneThreshold],
  );

  const decayed = decayResult.rowCount ?? 0;

  // Prune entities below threshold (with no edges)
  const pruneResult = await pool.query(
    `DELETE FROM graph_entities
     WHERE reinforcement_score < $1
       AND id NOT IN (
         SELECT source_id FROM graph_edges
         UNION
         SELECT target_id FROM graph_edges
       )
     RETURNING id`,
    [pruneThreshold],
  );

  const pruned = pruneResult.rowCount ?? 0;

  if (decayed > 0 || pruned > 0) {
    log.info(`Graph decay: ${decayed} entities decayed, ${pruned} pruned`);
  }

  return { decayed, pruned };
}

// ── 4. Edge Weight Decay ──────────────────────────────────────────
// Reduces edge weights on stale connections.

export async function decayEdgeWeights(decayFactor: number = 0.97): Promise<number> {
  const pool = getPool();

  const result = await pool.query(
    `UPDATE graph_edges
     SET weight = GREATEST(0.01, weight * $1)
     WHERE last_reinforced_at < NOW() - INTERVAL '14 days'
       AND weight > 0.01
     RETURNING id`,
    [decayFactor],
  );

  const decayed = result.rowCount ?? 0;

  if (decayed > 0) {
    log.dim(`Edge decay: ${decayed} edges reduced`);
  }

  return decayed;
}

// ── 5. Daily Memory Deduplication ──────────────────────────────────────────────
// Finds semantically similar daily memory entries (same user, recent 30 days)
// and merges near-duplicates. Uses simple content overlap heuristic
// (full embedding-based dedup is expensive; use keyword overlap as proxy).

export async function deduplicateDailyMemories(): Promise<number> {
  const pool = getPool();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const { rows: users } = await pool.query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM daily_memory WHERE date >= $1`,
    [cutoffStr],
  );

  let deduped = 0;

  for (const { user_id } of users) {
    const { rows } = await pool.query<{ id: string; date: string; entries: DailyMemoryEntry[] }>(
      `SELECT id, date, entries FROM daily_memory
       WHERE user_id = $1 AND date >= $2
       ORDER BY date DESC`,
      [user_id, cutoffStr],
    );

    // Collect all entries with their source row
    const allEntries: Array<{ rowDate: string; entry: DailyMemoryEntry; index: number }> = [];
    for (const row of rows) {
      (row.entries as DailyMemoryEntry[]).forEach((entry, index) => {
        allEntries.push({ rowDate: row.date, entry, index });
      });
    }

    // Find near-duplicate pairs using word overlap (Jaccard similarity)
    const toRemove = new Set<string>(); // "date:index" keys to remove

    for (let i = 0; i < allEntries.length; i++) {
      for (let j = i + 1; j < allEntries.length; j++) {
        const a = allEntries[i]!;
        const b = allEntries[j]!;
        if (a.entry.category !== b.entry.category) continue;
        if (toRemove.has(`${a.rowDate}:${a.index}`)) continue;

        const wordsA = new Set(a.entry.content.toLowerCase().split(/\W+/).filter((w) => w.length > 4));
        const wordsB = new Set(b.entry.content.toLowerCase().split(/\W+/).filter((w) => w.length > 4));
        const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
        const union = new Set([...wordsA, ...wordsB]).size;
        const jaccard = union > 0 ? intersection / union : 0;

        if (jaccard > 0.75) {
          // Keep the newer one, remove the older
          const removeKey = a.entry.timestamp <= b.entry.timestamp
            ? `${a.rowDate}:${a.index}`
            : `${b.rowDate}:${b.index}`;
          toRemove.add(removeKey);
          deduped++;
        }
      }
    }

    if (toRemove.size === 0) continue;

    // Apply removals per row
    for (const row of rows) {
      const removedIndices = new Set(
        [...toRemove]
          .filter((k) => k.startsWith(`${row.date}:`))
          .map((k) => parseInt(k.split(":")[1]!, 10)),
      );
      if (removedIndices.size === 0) continue;

      const filtered = (row.entries as DailyMemoryEntry[]).filter((_, i) => !removedIndices.has(i));
      await pool.query(
        `UPDATE daily_memory SET entries = $1::jsonb, updated_at = NOW()
         WHERE user_id = $2 AND date = $3`,
        [JSON.stringify(filtered), user_id, row.date],
      );
    }
  }

  if (deduped > 0) {
    log.info(`Deduplicated ${deduped} daily memory entries`);
  }

  return deduped;
}

// ── Run Full Consolidation Cycle ────────────────────────────────────
// Entry point for the cron scheduler.

export async function runConsolidation(): Promise<void> {
  const start = Date.now();
  log.info("Starting memory consolidation cycle...");

  try {
    const [dailyCount, themeCount, graphResult, edgeCount, dedupCount] = await Promise.all([
      consolidateDailyMemories(),
      promoteRecurringThemes(),
      decayAndPruneGraph(),
      decayEdgeWeights(),
      deduplicateDailyMemories(),
    ]);

    const elapsed = Date.now() - start;
    log.active(
      "Consolidation complete",
      `${elapsed}ms — daily:${dailyCount} themes:${themeCount} decay:${graphResult.decayed} prune:${graphResult.pruned} edges:${edgeCount} dedup:${dedupCount}`,
    );
  } catch (err) {
    log.error("Consolidation failed:", err);
  }
}
