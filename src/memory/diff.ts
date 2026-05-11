// ── Memory Diff / Changelog ──────────────────────────────────────────
// Show what changed in a user's memory between two timestamps.

import { getPool } from "../config/postgres.js";

export interface MemoryEntry {
  id: string;
  tier: string;
  date: string;
  category: string;
  content: string;
  createdAt: Date;
  updatedAt?: Date;
}

export interface MemoryDiff {
  added: MemoryEntry[];
  modified: MemoryEntry[];
  period: { from: Date; to: Date };
}

/**
 * Returns memory entries added or modified between two timestamps for a user.
 */
export async function diffMemoryState(
  userId: string,
  fromTimestamp: Date,
  toTimestamp: Date,
  workspaceId?: string,
): Promise<MemoryDiff> {
  const pool = getPool();

  const { rows: added } = await pool.query<{
    date: string;
    entries: Array<{ timestamp: number; category: string; content: string }>;
  }>(
    `SELECT date, entries
     FROM daily_memory
     WHERE user_id = $1
       AND workspace_id IS NOT DISTINCT FROM $2
       AND updated_at BETWEEN $3 AND $4
     ORDER BY date DESC`,
    [userId, workspaceId ?? null, fromTimestamp, toTimestamp],
  );

  const addedEntries: MemoryEntry[] = [];
  const modifiedEntries: MemoryEntry[] = [];

  for (const row of added) {
    for (const entry of (row.entries ?? [])) {
      const entryTime = new Date(entry.timestamp);
      const memEntry: MemoryEntry = {
        id: `daily:${userId}:${row.date}:${entry.timestamp}`,
        tier: "daily",
        date: row.date,
        category: entry.category,
        content: entry.content,
        createdAt: entryTime,
      };

      if (entryTime >= fromTimestamp) {
        addedEntries.push(memEntry);
      } else {
        modifiedEntries.push(memEntry);
      }
    }
  }

  return {
    added: addedEntries,
    modified: modifiedEntries,
    period: { from: fromTimestamp, to: toTimestamp },
  };
}

export interface ChangelogDay {
  date: string;
  added: number;
  modified: number;
  entries: MemoryEntry[];
}

/**
 * Group memory changes by date for a changelog view.
 */
export async function getMemoryChangelog(
  userId: string,
  days: number = 7,
  workspaceId?: string,
): Promise<ChangelogDay[]> {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

  const diff = await diffMemoryState(userId, from, to, workspaceId);
  const byDate = new Map<string, ChangelogDay>();

  for (const entry of [...diff.added, ...diff.modified]) {
    const day = entry.createdAt.toISOString().slice(0, 10);
    if (!byDate.has(day)) {
      byDate.set(day, { date: day, added: 0, modified: 0, entries: [] });
    }
    const record = byDate.get(day)!;
    if (diff.added.includes(entry)) record.added++;
    else record.modified++;
    record.entries.push(entry);
  }

  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
}
