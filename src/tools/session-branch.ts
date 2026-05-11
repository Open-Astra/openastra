import { z } from "zod";
import { randomUUID } from "node:crypto";
import { registerTool } from "./registry.js";
import { getPool } from "../config/postgres.js";
import { createBranch, diffBranch, mergeBranch } from "../memory/branches.js";

// ── session_branch ──────────────────────────────────────────────────
// Multi-session branching. Fork active sessions into parallel branches
// to run experiments, then merge back via debate. Each branch gets its
// own memory branch and can diverge independently.

const SessionBranchParams = z.object({
  action: z
    .enum(["fork", "list", "switch", "diff", "merge", "abandon", "status"])
    .describe("Action: fork session, list branches, switch active branch, diff against parent, merge, abandon, or check status"),
  branch_name: z.string().optional().describe("Name for the new branch (for fork)"),
  branch_id: z.string().optional().describe("Branch ID (for switch/diff/merge/abandon)"),
  description: z.string().optional().describe("Branch description (for fork)"),
  force_merge: z.boolean().default(false).describe("Force merge even with conflicts (for merge)"),
});

registerTool({
  name: "session_branch",
  description:
    "Multi-session branching for experiments. Fork the current session into parallel branches, each with its own memory state. Run experiments independently, then diff and merge results via debate.",
  parameters: SessionBranchParams,

  async execute(params, ctx) {
    const pool = getPool();

    switch (params.action) {
      case "fork": {
        if (!params.branch_name) return { error: "branch_name required for fork" };

        // Create a memory branch (snapshots current memory state)
        const memBranch = await createBranch(
          ctx.uid,
          params.branch_name,
          params.description ?? `Session fork: ${params.branch_name}`,
        );

        // Create a session branch record
        const branchId = randomUUID();
        const sessionBranch = {
          id: branchId,
          name: params.branch_name,
          description: params.description ?? "",
          parentSessionId: ctx.sessionId,
          memoryBranchId: memBranch.id,
          status: "active",
          messageCount: 0,
          createdAt: Date.now(),
        };

        await pool.query(
          `INSERT INTO session_branches (id, uid, session_id, value, created_at, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, NOW(), NOW())`,
          [branchId, ctx.uid, ctx.sessionId, JSON.stringify(sessionBranch)],
        );

        return {
          result: "Session forked",
          branchId,
          branchName: params.branch_name,
          memoryBranchId: memBranch.id,
          memoryStats: memBranch.stats,
        };
      }

      case "list": {
        const { rows } = await pool.query<{
          id: string;
          value: {
            name: string;
            status: string;
            messageCount: number;
            createdAt: number;
            parentSessionId: string;
          };
        }>(
          `SELECT id, value FROM session_branches
           WHERE uid = $1 AND value->>'status' = 'active'
           ORDER BY created_at DESC LIMIT 20`,
          [ctx.uid],
        );

        return {
          result: `${rows.length} active branch(es)`,
          branches: rows.map((r) => ({
            id: r.id,
            name: r.value.name,
            status: r.value.status,
            messageCount: r.value.messageCount,
            createdAt: new Date(r.value.createdAt).toISOString(),
          })),
        };
      }

      case "switch": {
        if (!params.branch_id) return { error: "branch_id required for switch" };

        const { rows } = await pool.query<{
          value: { name: string; memoryBranchId: string; status: string };
        }>(
          "SELECT value FROM session_branches WHERE id = $1 AND uid = $2",
          [params.branch_id, ctx.uid],
        );

        if (rows.length === 0) return { error: "Branch not found" };
        if (rows[0]!.value.status !== "active") return { error: "Branch is not active" };

        return {
          result: "Switched to branch",
          branchId: params.branch_id,
          branchName: rows[0]!.value.name,
          memoryBranchId: rows[0]!.value.memoryBranchId,
          note: "Subsequent memory reads/writes will use this branch's memory state",
        };
      }

      case "diff": {
        if (!params.branch_id) return { error: "branch_id required for diff" };

        const { rows } = await pool.query<{
          value: { memoryBranchId: string; name: string };
        }>(
          "SELECT value FROM session_branches WHERE id = $1 AND uid = $2",
          [params.branch_id, ctx.uid],
        );

        if (rows.length === 0) return { error: "Branch not found" };

        try {
          const diff = await diffBranch(ctx.uid, rows[0]!.value.memoryBranchId);

          return {
            result: "Branch diff",
            branchName: rows[0]!.value.name,
            additions: diff.additions.length,
            modifications: diff.modifications.length,
            conflicts: diff.conflicts.length,
            details: {
              additions: diff.additions,
              modifications: diff.modifications,
              conflicts: diff.conflicts,
            },
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { error: `Diff failed: ${message}` };
        }
      }

      case "merge": {
        if (!params.branch_id) return { error: "branch_id required for merge" };

        const { rows } = await pool.query<{
          value: { memoryBranchId: string; name: string };
        }>(
          "SELECT value FROM session_branches WHERE id = $1 AND uid = $2",
          [params.branch_id, ctx.uid],
        );

        if (rows.length === 0) return { error: "Branch not found" };

        try {
          const mergeResult = await mergeBranch(
            ctx.uid,
            rows[0]!.value.memoryBranchId,
            params.force_merge,
          );

          if (!mergeResult.merged) {
            return {
              result: "Merge blocked — conflicts detected",
              conflicts: mergeResult.conflicts,
              hint: "Use force_merge: true to merge anyway, or resolve conflicts first",
            };
          }

          // Mark session branch as merged
          await pool.query(
            `UPDATE session_branches SET value = value || '{"status":"merged"}'::jsonb, updated_at = NOW()
             WHERE id = $1`,
            [params.branch_id],
          );

          return {
            result: "Branch merged successfully",
            branchId: params.branch_id,
            branchName: rows[0]!.value.name,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { error: `Merge failed: ${message}` };
        }
      }

      case "abandon": {
        if (!params.branch_id) return { error: "branch_id required for abandon" };

        await pool.query(
          `UPDATE session_branches SET value = value || '{"status":"abandoned"}'::jsonb, updated_at = NOW()
           WHERE id = $1 AND uid = $2`,
          [params.branch_id, ctx.uid],
        );

        return { result: "Branch abandoned", branchId: params.branch_id };
      }

      case "status": {
        // Get counts of active branches and their stats
        const { rows } = await pool.query<{
          active: string;
          merged: string;
          abandoned: string;
        }>(
          `SELECT
             COUNT(*) FILTER (WHERE value->>'status' = 'active')::text AS active,
             COUNT(*) FILTER (WHERE value->>'status' = 'merged')::text AS merged,
             COUNT(*) FILTER (WHERE value->>'status' = 'abandoned')::text AS abandoned
           FROM session_branches WHERE uid = $1`,
          [ctx.uid],
        );

        return {
          result: "Session branching status",
          active: parseInt(rows[0]?.active ?? "0"),
          merged: parseInt(rows[0]?.merged ?? "0"),
          abandoned: parseInt(rows[0]?.abandoned ?? "0"),
          currentSession: ctx.sessionId,
        };
      }

      default:
        return { error: "Unknown action" };
    }
  },
});
