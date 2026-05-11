import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import type { DailyMemoryDoc } from "./types.js";

// ── Memory Branching & Version Control ──────────────────────────────
// Git-style branching for the entire memory state. Users or agents
// can fork memory into parallel branches for experimentation.
//
// Postgres tables: memory_branches, branch_daily_memory,
//                  branch_profiles, branch_graph_entities
//
// The "main" branch is the default — its data lives in the normal
// tables (daily_memory, memory_profiles). Named branches copy from
// main at creation time and diverge independently.

// ── Types ───────────────────────────────────────────────────────────

export interface MemoryBranch {
  id: string;
  uid: string;
  name: string;
  description: string;
  parentBranch: string; // "main" or another branch ID
  createdAt: number;
  lastModifiedAt: number;
  status: "active" | "merged" | "abandoned";
  stats: {
    dailyEntries: number;
    profileNotes: number;
    graphEntities: number;
  };
}

export interface BranchDiff {
  branchId: string;
  branchName: string;
  additions: DiffEntry[];
  modifications: DiffEntry[];
  deletions: DiffEntry[];
  conflicts: ConflictEntry[];
}

export interface DiffEntry {
  path: string;
  type: "daily" | "profile" | "graph";
  content: string;
}

export interface ConflictEntry {
  path: string;
  type: "daily" | "profile" | "graph";
  mainContent: string;
  branchContent: string;
  description: string;
}

// ── Row Mapper ──────────────────────────────────────────────────────

function rowToBranch(row: Record<string, unknown>): MemoryBranch {
  const stats = (row.stats as MemoryBranch["stats"]) ?? {
    dailyEntries: 0,
    profileNotes: 0,
    graphEntities: 0,
  };
  return {
    id: row.id as string,
    uid: row.user_id as string,
    name: row.name as string,
    description: (row.description as string) ?? "",
    parentBranch: (row.parent_branch as string) ?? "main",
    createdAt: new Date(row.created_at as string).getTime(),
    lastModifiedAt: row.last_modified_at
      ? new Date(row.last_modified_at as string).getTime()
      : Date.now(),
    status: (row.status as MemoryBranch["status"]) ?? "active",
    stats,
  };
}

// ── Branch Operations ───────────────────────────────────────────────

export async function createBranch(
  uid: string,
  name: string,
  description: string = "",
  parentBranch: string = "main",
): Promise<MemoryBranch> {
  const pool = getPool();
  const id = randomUUID();
  const stats = { dailyEntries: 0, profileNotes: 0, graphEntities: 0 };

  await pool.query(
    `INSERT INTO memory_branches (id, user_id, name, description, parent_branch, stats)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [id, uid, name, description, parentBranch, JSON.stringify(stats)],
  );

  // Copy current memory state into the branch
  const updatedStats = await copyMemoryToBranch(uid, id);

  // Update branch stats
  await pool.query(
    "UPDATE memory_branches SET stats = $1::jsonb WHERE id = $2",
    [JSON.stringify(updatedStats), id],
  );

  console.log(`[branches] Created branch "${name}" (${id.slice(0, 8)}) for uid=${uid}`);

  return {
    id,
    uid,
    name,
    description,
    parentBranch,
    createdAt: Date.now(),
    lastModifiedAt: Date.now(),
    status: "active",
    stats: updatedStats,
  };
}

export async function listBranches(uid: string): Promise<MemoryBranch[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM memory_branches
     WHERE user_id = $1 AND status = 'active'
     ORDER BY created_at DESC LIMIT 20`,
    [uid],
  );
  return rows.map(rowToBranch);
}

export async function getBranch(uid: string, branchId: string): Promise<MemoryBranch | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    "SELECT * FROM memory_branches WHERE id = $1 AND user_id = $2",
    [branchId, uid],
  );
  return rows.length > 0 ? rowToBranch(rows[0]) : null;
}

// ── Copy Memory State ───────────────────────────────────────────────
// Snapshots the current memory (daily + profile) into a branch.

async function copyMemoryToBranch(
  uid: string,
  branchId: string,
): Promise<MemoryBranch["stats"]> {
  const pool = getPool();
  const client = await pool.connect();
  let dailyEntries = 0;
  let profileNotes = 0;
  let graphEntities = 0;

  try {
    await client.query("BEGIN");

    // Copy daily memory (last 7 days)
    const { rows: dailyRows } = await client.query<{
      date: string;
      entries: unknown[];
    }>(
      `SELECT date, entries FROM daily_memory
       WHERE user_id = $1 ORDER BY date DESC LIMIT 7`,
      [uid],
    );

    for (const row of dailyRows) {
      await client.query(
        `INSERT INTO branch_daily_memory (branch_id, user_id, date, entries)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [branchId, uid, row.date, JSON.stringify(row.entries)],
      );
      dailyEntries += (row.entries as unknown[]).length;
    }

    // Copy profile
    const { rows: profileRows } = await client.query<{
      profile_data: Record<string, unknown>;
    }>(
      `SELECT profile_data FROM memory_profiles WHERE user_id = $1`,
      [uid],
    );

    if (profileRows.length > 0) {
      const profile = profileRows[0]!.profile_data;
      await client.query(
        `INSERT INTO branch_profiles (branch_id, user_id, profile_data)
         VALUES ($1, $2, $3::jsonb)`,
        [branchId, uid, JSON.stringify(profile)],
      );
      const notes = (profile as Record<string, unknown>).strategicNotes;
      profileNotes = Array.isArray(notes) ? notes.length : 0;
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return { dailyEntries, profileNotes, graphEntities };
}

// ── Diff: Compare Branch to Main ────────────────────────────────────

export async function diffBranch(uid: string, branchId: string): Promise<BranchDiff> {
  const pool = getPool();
  const branch = await getBranch(uid, branchId);
  if (!branch) throw new Error(`Branch not found: ${branchId}`);

  const additions: DiffEntry[] = [];
  const modifications: DiffEntry[] = [];
  const conflicts: ConflictEntry[] = [];

  // Compare profiles
  const { rows: mainProfileRows } = await pool.query<{ profile_data: Record<string, unknown> }>(
    "SELECT profile_data FROM memory_profiles WHERE user_id = $1",
    [uid],
  );
  const { rows: branchProfileRows } = await pool.query<{ profile_data: Record<string, unknown> }>(
    "SELECT profile_data FROM branch_profiles WHERE branch_id = $1 AND user_id = $2",
    [branchId, uid],
  );

  if (branchProfileRows.length > 0) {
    const branchData = branchProfileRows[0]!.profile_data as Record<string, unknown>;
    const mainData = mainProfileRows.length > 0
      ? (mainProfileRows[0]!.profile_data as Record<string, unknown>)
      : null;

    if (!mainData) {
      additions.push({
        path: "profile",
        type: "profile",
        content: JSON.stringify(branchData.strategicNotes),
      });
    } else {
      const mainNotes = new Set((mainData.strategicNotes as string[]) ?? []);
      const branchNotes = (branchData.strategicNotes as string[]) ?? [];
      const newNotes = branchNotes.filter((n) => !mainNotes.has(n));

      if (newNotes.length > 0) {
        const mainUpdated = (mainData.updatedAt as number) ?? 0;
        if (mainUpdated > branch.createdAt) {
          conflicts.push({
            path: "profile/strategicNotes",
            type: "profile",
            mainContent: JSON.stringify(mainData.strategicNotes),
            branchContent: JSON.stringify(branchNotes),
            description: "Both main and branch modified strategic notes",
          });
        } else {
          modifications.push({
            path: "profile/strategicNotes",
            type: "profile",
            content: JSON.stringify(newNotes),
          });
        }
      }
    }
  }

  // Compare daily memory
  const { rows: branchDailyRows } = await pool.query<{
    date: string;
    entries: unknown[];
  }>(
    "SELECT date, entries FROM branch_daily_memory WHERE branch_id = $1 AND user_id = $2",
    [branchId, uid],
  );

  for (const branchRow of branchDailyRows) {
    const { rows: mainDailyRows } = await pool.query<{ entries: unknown[] }>(
      "SELECT entries FROM daily_memory WHERE user_id = $1 AND date = $2",
      [uid, branchRow.date],
    );

    if (mainDailyRows.length === 0) {
      additions.push({
        path: `daily/${branchRow.date}`,
        type: "daily",
        content: `${(branchRow.entries as unknown[]).length} entries`,
      });
    } else {
      const mainEntries = mainDailyRows[0]!.entries as unknown[];
      const branchEntries = branchRow.entries as unknown[];
      if (branchEntries.length > mainEntries.length) {
        modifications.push({
          path: `daily/${branchRow.date}`,
          type: "daily",
          content: `${branchEntries.length - mainEntries.length} new entries`,
        });
      }
    }
  }

  return {
    branchId,
    branchName: branch.name,
    additions,
    modifications,
    deletions: [],
    conflicts,
  };
}

// ── Merge: Apply Branch Changes to Main ─────────────────────────────

export async function mergeBranch(
  uid: string,
  branchId: string,
  force: boolean = false,
): Promise<{ merged: boolean; conflicts: ConflictEntry[] }> {
  const diff = await diffBranch(uid, branchId);

  if (diff.conflicts.length > 0 && !force) {
    return { merged: false, conflicts: diff.conflicts };
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Apply additions — new daily entries
    for (const addition of diff.additions) {
      if (addition.type === "daily") {
        const dateStr = addition.path.replace("daily/", "");
        const { rows } = await client.query<{ entries: unknown[] }>(
          "SELECT entries FROM branch_daily_memory WHERE branch_id = $1 AND user_id = $2 AND date = $3",
          [branchId, uid, dateStr],
        );
        if (rows.length > 0) {
          await client.query(
            `INSERT INTO daily_memory (user_id, date, entries)
             VALUES ($1, $2, $3::jsonb)
             ON CONFLICT (user_id, workspace_id, date) DO UPDATE
             SET entries = $3::jsonb, updated_at = NOW()`,
            [uid, dateStr, JSON.stringify(rows[0]!.entries)],
          );
        }
      }
    }

    // Apply modifications — merge daily entries
    for (const mod of diff.modifications) {
      if (mod.type === "daily") {
        const dateStr = mod.path.replace("daily/", "");
        const { rows: branchRows } = await client.query<{ entries: DailyMemoryDoc["entries"] }>(
          "SELECT entries FROM branch_daily_memory WHERE branch_id = $1 AND user_id = $2 AND date = $3",
          [branchId, uid, dateStr],
        );
        const { rows: mainRows } = await client.query<{ entries: DailyMemoryDoc["entries"] }>(
          "SELECT entries FROM daily_memory WHERE user_id = $1 AND date = $2",
          [uid, dateStr],
        );

        if (branchRows.length > 0 && mainRows.length > 0) {
          const branchEntries = branchRows[0]!.entries as Array<{ content: string }>;
          const mainEntries = mainRows[0]!.entries as Array<{ content: string }>;
          const mainContentSet = new Set(mainEntries.map((e) => e.content));
          const newEntries = branchEntries.filter((e) => !mainContentSet.has(e.content));

          if (newEntries.length > 0) {
            const merged = [...mainEntries, ...newEntries];
            await client.query(
              "UPDATE daily_memory SET entries = $1::jsonb, updated_at = NOW() WHERE user_id = $2 AND date = $3",
              [JSON.stringify(merged), uid, dateStr],
            );
          }
        }
      }

      if (mod.type === "profile") {
        const { rows: branchProfileRows } = await client.query<{
          profile_data: Record<string, unknown>;
        }>(
          "SELECT profile_data FROM branch_profiles WHERE branch_id = $1 AND user_id = $2",
          [branchId, uid],
        );

        if (branchProfileRows.length > 0) {
          const branchData = branchProfileRows[0]!.profile_data;
          const { rows: mainProfileRows } = await client.query<{
            profile_data: Record<string, unknown>;
          }>(
            "SELECT profile_data FROM memory_profiles WHERE user_id = $1",
            [uid],
          );

          const mainData = mainProfileRows.length > 0 ? mainProfileRows[0]!.profile_data : null;
          const mainNotes = new Set((mainData?.strategicNotes as string[]) ?? []);
          const branchNotes = (branchData.strategicNotes as string[]) ?? [];
          const newNotes = branchNotes.filter((n) => !mainNotes.has(n));

          if (newNotes.length > 0) {
            const merged = [...((mainData?.strategicNotes as string[]) ?? []), ...newNotes];
            await client.query(
              `UPDATE memory_profiles
               SET profile_data = jsonb_set(profile_data, '{strategicNotes}', $1::jsonb),
                   updated_at = NOW()
               WHERE user_id = $2`,
              [JSON.stringify(merged), uid],
            );
          }
        }
      }
    }

    // Mark branch as merged
    await client.query(
      "UPDATE memory_branches SET status = 'merged', merged_at = NOW(), last_modified_at = NOW() WHERE id = $1",
      [branchId],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  console.log(`[branches] Merged branch ${branchId.slice(0, 8)} for uid=${uid}`);
  return { merged: true, conflicts: [] };
}

// ── Abandon Branch ──────────────────────────────────────────────────

export async function abandonBranch(uid: string, branchId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    "UPDATE memory_branches SET status = 'abandoned', last_modified_at = NOW() WHERE id = $1 AND user_id = $2",
    [branchId, uid],
  );
  console.log(`[branches] Abandoned branch ${branchId.slice(0, 8)} for uid=${uid}`);
}
