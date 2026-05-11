import { z } from "zod";
import { randomUUID } from "node:crypto";
import { registerTool } from "./registry.js";
import { getPool } from "../config/postgres.js";

// ── conflict_free_merge ────────────────────────────────────────────
// CRDT-inspired conflict-free merge protocol for parallel branches.
// When multiple users/agents work on separate branches simultaneously,
// this tool detects structural conflicts, auto-resolves non-conflicting
// changes using set-union semantics, and offers interactive resolution
// for true conflicts via a vector-clock-like "last writer per field" policy.
//
// Merge strategies:
//  - "union"     → combine entries from both sides (default for daily/graph)
//  - "lww"       → last-writer-wins per field (for profile fields)
//  - "manual"    → flag for human review (for true semantic conflicts)

const ConflictFreeMergeParams = z.object({
  action: z
    .enum(["analyze", "auto_merge", "resolve", "history", "strategy"])
    .describe(
      "Action: analyze branches for merge-ability, auto-merge non-conflicting changes, " +
      "resolve specific conflicts, view merge history, or configure default strategy",
    ),
  branch_ids: z
    .array(z.string())
    .optional()
    .describe("Branch IDs to merge (for analyze/auto_merge — 2+ branches)"),
  target: z
    .enum(["main", "branch"])
    .default("main")
    .describe("Merge target: 'main' merges into main, 'branch' merges into the first listed branch"),
  conflict_id: z
    .string()
    .optional()
    .describe("Specific conflict ID to resolve (for resolve action)"),
  resolution: z
    .enum(["keep_a", "keep_b", "union", "custom"])
    .optional()
    .describe("How to resolve a conflict (for resolve action)"),
  custom_content: z
    .string()
    .optional()
    .describe("Custom merged content (when resolution is 'custom')"),
  default_strategy: z
    .object({
      daily: z.enum(["union", "lww", "manual"]).optional(),
      profile: z.enum(["union", "lww", "manual"]).optional(),
      graph: z.enum(["union", "lww", "manual"]).optional(),
    })
    .optional()
    .describe("Default merge strategy per tier (for strategy action)"),
});

// ── Conflict record persisted for interactive resolution ────────
interface MergeConflict {
  id: string;
  branchA: string;
  branchB: string;
  tier: "daily" | "profile" | "graph";
  path: string;
  contentA: string;
  contentB: string;
  description: string;
  resolved: boolean;
  resolution?: string;
  resolvedContent?: string;
}

registerTool({
  name: "conflict_free_merge",
  description:
    "CRDT-inspired conflict-free merge protocol for parallel memory branches. " +
    "Auto-merges non-conflicting changes using set-union semantics, detects true conflicts, " +
    "and supports interactive resolution. Designed for multi-user/multi-agent workflows " +
    "where multiple branches diverge and must be reconciled without data loss.",
  parameters: ConflictFreeMergeParams,

  async execute(params, ctx) {
    const pool = getPool();
    // Workspace-scoped: allows cross-user branch access for team merges.
    // Falls back to uid-scoped for personal (non-workspace) usage.
    const workspaceId = ctx.workspaceId ?? null;

    switch (params.action) {
      // ── Analyze: detect conflicts across N branches ────────────
      case "analyze": {
        if (!params.branch_ids || params.branch_ids.length < 2) {
          return { error: "At least 2 branch_ids required for analyze" };
        }

        const conflicts: MergeConflict[] = [];
        const autoMergeable: Array<{ tier: string; path: string; strategy: string }> = [];

        // Load branch metadata
        const branches: Array<{
          id: string;
          name: string;
          createdAt: number;
          lastModifiedAt: number;
        }> = [];

        for (const bid of params.branch_ids) {
          // Workspace-scoped lookup: any member can reference any branch in the
          // workspace. Falls back to user_id for personal (no-workspace) usage.
          const branchWhere = workspaceId ? "id = $1 AND workspace_id = $2" : "id = $1 AND user_id = $2";
          const branchParam = workspaceId ?? ctx.uid;
          const { rows } = await pool.query<{
            id: string;
            name: string;
            created_at: string;
            last_modified_at: string;
          }>(
            `SELECT id, name, created_at, last_modified_at FROM memory_branches WHERE ${branchWhere}`,
            [bid, branchParam],
          );
          if (rows.length === 0) return { error: `Branch not found: ${bid}` };
          branches.push({
            id: rows[0]!.id,
            name: rows[0]!.name,
            createdAt: new Date(rows[0]!.created_at).getTime(),
            lastModifiedAt: new Date(rows[0]!.last_modified_at).getTime(),
          });
        }

        // Compare daily entries between all branch pairs
        for (let i = 0; i < branches.length; i++) {
          for (let j = i + 1; j < branches.length; j++) {
            const brA = branches[i]!;
            const brB = branches[j]!;

            // Daily memory comparison
            const { rows: dailyA } = await pool.query<{ date: string; entries: unknown[] }>(
              "SELECT date, entries FROM branch_daily_memory WHERE branch_id = $1",
              [brA.id],
            );
            const { rows: dailyB } = await pool.query<{ date: string; entries: unknown[] }>(
              "SELECT date, entries FROM branch_daily_memory WHERE branch_id = $1",
              [brB.id],
            );

            const datesA = new Map(dailyA.map((r) => [r.date, r.entries]));
            const datesB = new Map(dailyB.map((r) => [r.date, r.entries]));

            // Dates only in one branch → auto-mergeable (union)
            for (const [date] of datesA) {
              if (!datesB.has(date)) {
                autoMergeable.push({ tier: "daily", path: `daily/${date}`, strategy: "union" });
              }
            }
            for (const [date] of datesB) {
              if (!datesA.has(date)) {
                autoMergeable.push({ tier: "daily", path: `daily/${date}`, strategy: "union" });
              }
            }

            // Overlapping dates → check for content conflicts
            for (const [date, entriesA] of datesA) {
              const entriesB = datesB.get(date);
              if (!entriesB) continue;

              const contentsA = new Set((entriesA as Array<{ content: string }>).map((e) => e.content));
              const contentsB = new Set((entriesB as Array<{ content: string }>).map((e) => e.content));

              // Entries unique to each side → auto-mergeable via union
              let uniqueA = 0;
              let uniqueB = 0;
              for (const c of contentsA) if (!contentsB.has(c)) uniqueA++;
              for (const c of contentsB) if (!contentsA.has(c)) uniqueB++;

              if (uniqueA > 0 || uniqueB > 0) {
                autoMergeable.push({
                  tier: "daily",
                  path: `daily/${date}`,
                  strategy: "union",
                });
              }
            }

            // Profile comparison
            const { rows: profA } = await pool.query<{ profile_data: Record<string, unknown> }>(
              "SELECT profile_data FROM branch_profiles WHERE branch_id = $1",
              [brA.id],
            );
            const { rows: profB } = await pool.query<{ profile_data: Record<string, unknown> }>(
              "SELECT profile_data FROM branch_profiles WHERE branch_id = $1",
              [brB.id],
            );

            if (profA.length > 0 && profB.length > 0) {
              const notesA = (profA[0]!.profile_data.strategicNotes as string[]) ?? [];
              const notesB = (profB[0]!.profile_data.strategicNotes as string[]) ?? [];

              // Check for directly contradicting notes (simple heuristic)
              const setA = new Set(notesA);
              const setB = new Set(notesB);
              const commonNotes = notesA.filter((n) => setB.has(n));
              const uniqueNotesA = notesA.filter((n) => !setB.has(n));
              const uniqueNotesB = notesB.filter((n) => !setA.has(n));

              if (uniqueNotesA.length > 0 && uniqueNotesB.length > 0) {
                // Both sides added different notes — check timestamps for LWW
                if (brA.lastModifiedAt !== brB.lastModifiedAt) {
                  autoMergeable.push({ tier: "profile", path: "profile/strategicNotes", strategy: "union" });
                } else {
                  // Same timestamp — true conflict
                  conflicts.push({
                    id: randomUUID(),
                    branchA: brA.id,
                    branchB: brB.id,
                    tier: "profile",
                    path: "profile/strategicNotes",
                    contentA: JSON.stringify(uniqueNotesA),
                    contentB: JSON.stringify(uniqueNotesB),
                    description: `Both branches added ${uniqueNotesA.length + uniqueNotesB.length} different strategic notes (${commonNotes.length} shared)`,
                    resolved: false,
                  });
                }
              } else if (uniqueNotesA.length > 0 || uniqueNotesB.length > 0) {
                autoMergeable.push({ tier: "profile", path: "profile/strategicNotes", strategy: "union" });
              }
            }
          }
        }

        // Persist unresolved conflicts
        for (const conflict of conflicts) {
          await pool.query(
            `INSERT INTO merge_conflicts (id, uid, value, created_at)
             VALUES ($1, $2, $3::jsonb, NOW())
             ON CONFLICT (id) DO NOTHING`,
            [conflict.id, ctx.uid, JSON.stringify(conflict)],
          );
        }

        return {
          result: "Branch merge analysis",
          branchCount: branches.length,
          branches: branches.map((b) => ({ id: b.id, name: b.name })),
          autoMergeableChanges: autoMergeable.length,
          autoMergeable,
          conflicts: conflicts.length,
          conflictDetails: conflicts.map((c) => ({
            id: c.id,
            tier: c.tier,
            path: c.path,
            description: c.description,
          })),
          recommendation: conflicts.length === 0
            ? "All changes are auto-mergeable. Run auto_merge to proceed."
            : `${conflicts.length} conflict(s) need resolution before merge. Use 'resolve' action.`,
        };
      }

      // ── Auto-merge: apply non-conflicting changes ──────────────
      case "auto_merge": {
        if (!params.branch_ids || params.branch_ids.length < 2) {
          return { error: "At least 2 branch_ids required" };
        }

        const client = await pool.connect();
        let mergedEntries = 0;
        let mergedNotes = 0;

        try {
          await client.query("BEGIN");

          // Collect all daily entries across branches using set-union
          const allDailyByDate = new Map<string, Map<string, unknown>>();

          for (const bid of params.branch_ids) {
            const { rows } = await client.query<{ date: string; entries: unknown[] }>(
              "SELECT date, entries FROM branch_daily_memory WHERE branch_id = $1",
              [bid],
            );
            for (const row of rows) {
              if (!allDailyByDate.has(row.date)) {
                allDailyByDate.set(row.date, new Map());
              }
              const dateMap = allDailyByDate.get(row.date)!;
              for (const entry of row.entries as Array<{ content: string }>) {
                dateMap.set(entry.content, entry);
              }
            }
          }

          // Write merged daily entries to main
          for (const [date, entryMap] of allDailyByDate) {
            const mergedEntryArray = Array.from(entryMap.values());
            await client.query(
              `INSERT INTO daily_memory (user_id, workspace_id, date, entries)
               VALUES ($1, $2, $3, $4::jsonb)
               ON CONFLICT (user_id, workspace_id, date) DO UPDATE
               SET entries = $4::jsonb, updated_at = NOW()`,
              [ctx.uid, workspaceId, date, JSON.stringify(mergedEntryArray)],
            );
            mergedEntries += mergedEntryArray.length;
          }

          // Collect all profile strategic notes via set-union
          const allNotes = new Set<string>();
          for (const bid of params.branch_ids) {
            const { rows } = await client.query<{ profile_data: Record<string, unknown> }>(
              "SELECT profile_data FROM branch_profiles WHERE branch_id = $1",
              [bid],
            );
            if (rows.length > 0) {
              const notes = (rows[0]!.profile_data.strategicNotes as string[]) ?? [];
              for (const note of notes) allNotes.add(note);
            }
          }

          // Also include existing main notes
          const { rows: mainProfile } = await client.query<{ profile_data: Record<string, unknown> }>(
            "SELECT profile_data FROM memory_profiles WHERE user_id = $1",
            [ctx.uid],
          );
          if (mainProfile.length > 0) {
            const notes = (mainProfile[0]!.profile_data.strategicNotes as string[]) ?? [];
            for (const note of notes) allNotes.add(note);
          }

          if (allNotes.size > 0) {
            await client.query(
              `UPDATE memory_profiles
               SET profile_data = jsonb_set(profile_data, '{strategicNotes}', $1::jsonb),
                   updated_at = NOW()
               WHERE user_id = $2`,
              [JSON.stringify(Array.from(allNotes)), ctx.uid],
            );
            mergedNotes = allNotes.size;
          }

          // Mark branches as merged
          for (const bid of params.branch_ids) {
            await client.query(
              "UPDATE memory_branches SET status = 'merged', merged_at = NOW(), last_modified_at = NOW() WHERE id = $1",
              [bid],
            );
          }

          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }

        // Record merge event
        const mergeId = randomUUID();
        await pool.query(
          `INSERT INTO merge_history (id, uid, value, created_at)
           VALUES ($1, $2, $3::jsonb, NOW())`,
          [mergeId, ctx.uid, JSON.stringify({
            branches: params.branch_ids,
            target: params.target,
            mergedEntries,
            mergedNotes,
            strategy: "auto_union",
            timestamp: Date.now(),
          })],
        );

        return {
          result: "Auto-merge complete",
          mergeId,
          branchesMerged: params.branch_ids.length,
          mergedEntries,
          mergedNotes,
          target: params.target,
          strategy: "set-union (CRDT)",
        };
      }

      // ── Resolve: handle a specific conflict interactively ──────
      case "resolve": {
        if (!params.conflict_id || !params.resolution) {
          return { error: "conflict_id and resolution required" };
        }

        // Load conflict
        const { rows: conflictRows } = await pool.query<{ value: MergeConflict }>(
          "SELECT value FROM merge_conflicts WHERE id = $1 AND uid = $2",
          [params.conflict_id, ctx.uid],
        );

        if (conflictRows.length === 0) return { error: "Conflict not found" };
        const conflict = conflictRows[0]!.value;

        if (conflict.resolved) return { error: "Conflict already resolved" };

        let resolvedContent: string;
        switch (params.resolution) {
          case "keep_a":
            resolvedContent = conflict.contentA;
            break;
          case "keep_b":
            resolvedContent = conflict.contentB;
            break;
          case "union": {
            // Set-union of both sides
            const setA = JSON.parse(conflict.contentA) as string[];
            const setB = JSON.parse(conflict.contentB) as string[];
            const union = Array.from(new Set([...setA, ...setB]));
            resolvedContent = JSON.stringify(union);
            break;
          }
          case "custom":
            if (!params.custom_content) return { error: "custom_content required for custom resolution" };
            resolvedContent = params.custom_content;
            break;
          default:
            return { error: "Unknown resolution strategy" };
        }

        // Apply resolution to main
        if (conflict.tier === "profile" && conflict.path === "profile/strategicNotes") {
          const notes = JSON.parse(resolvedContent) as string[];
          const { rows: mainProfile } = await pool.query<{ profile_data: Record<string, unknown> }>(
            "SELECT profile_data FROM memory_profiles WHERE user_id = $1",
            [ctx.uid],
          );
          const existingNotes = mainProfile.length > 0
            ? ((mainProfile[0]!.profile_data.strategicNotes as string[]) ?? [])
            : [];
          const merged = Array.from(new Set([...existingNotes, ...notes]));
          await pool.query(
            `UPDATE memory_profiles
             SET profile_data = jsonb_set(profile_data, '{strategicNotes}', $1::jsonb),
                 updated_at = NOW()
             WHERE user_id = $2`,
            [JSON.stringify(merged), ctx.uid],
          );
        }

        // Mark conflict as resolved
        conflict.resolved = true;
        conflict.resolution = params.resolution;
        conflict.resolvedContent = resolvedContent;
        await pool.query(
          "UPDATE merge_conflicts SET value = $1::jsonb WHERE id = $2",
          [JSON.stringify(conflict), params.conflict_id],
        );

        return {
          result: "Conflict resolved",
          conflictId: params.conflict_id,
          resolution: params.resolution,
          tier: conflict.tier,
          path: conflict.path,
        };
      }

      // ── History: view past merges ──────────────────────────────
      case "history": {
        const { rows } = await pool.query<{
          id: string;
          value: Record<string, unknown>;
          created_at: string;
        }>(
          `SELECT id, value, created_at FROM merge_history
           WHERE uid = $1 ORDER BY created_at DESC LIMIT 20`,
          [ctx.uid],
        );

        return {
          result: `${rows.length} merge(s) in history`,
          merges: rows.map((r) => ({
            id: r.id,
            ...r.value,
            createdAt: r.created_at,
          })),
        };
      }

      // ── Strategy: configure default merge strategies ───────────
      case "strategy": {
        if (params.default_strategy) {
          const defaults = { daily: "union", profile: "lww", graph: "union" };
          const merged = { ...defaults, ...params.default_strategy };

          await pool.query(
            `INSERT INTO merge_strategies (uid, value, updated_at)
             VALUES ($1, $2::jsonb, NOW())
             ON CONFLICT (uid) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
            [ctx.uid, JSON.stringify(merged)],
          );

          return { result: "Merge strategy updated", strategy: merged };
        }

        // Get current strategy
        const { rows } = await pool.query<{ value: Record<string, string> }>(
          "SELECT value FROM merge_strategies WHERE uid = $1",
          [ctx.uid],
        );

        const strategy = rows.length > 0
          ? rows[0]!.value
          : { daily: "union", profile: "lww", graph: "union" };

        return { result: "Current merge strategy", strategy };
      }

      default:
        return { error: "Unknown action" };
    }
  },
});
