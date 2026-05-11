import { z } from "zod";
import { registerTool } from "./registry.js";
import { getPool } from "../config/postgres.js";

// ── memory_budget ───────────────────────────────────────────────────
// Per-agent memory access budgets. Enforces limits on how much memory
// each sub-agent can read/write per tier, with forced compaction when
// thresholds are exceeded.

const MemoryBudgetParams = z.object({
  action: z
    .enum(["set", "check", "enforce", "list"])
    .describe("Action: set budget, check usage, enforce limits, or list all budgets"),
  agent_id: z.string().optional().describe("Agent ID to set/check budget for"),
  limits: z
    .object({
      daily_entries: z.number().optional().describe("Max daily memory entries"),
      profile_notes: z.number().optional().describe("Max profile strategic notes"),
      graph_entities: z.number().optional().describe("Max graph entities"),
      graph_edges: z.number().optional().describe("Max graph edges"),
      session_messages: z.number().optional().describe("Max session messages retained"),
    })
    .optional()
    .describe("Memory tier limits (for set action)"),
});

registerTool({
  name: "memory_budget",
  description:
    "Manage per-agent memory budgets. Set limits on how much memory each agent/sub-agent can use per tier (daily entries, profile notes, graph entities). Enforce compaction when exceeded.",
  parameters: MemoryBudgetParams,

  async execute(params, ctx) {
    const pool = getPool();
    const targetAgentId = params.agent_id ?? ctx.agentId;

    switch (params.action) {
      case "set": {
        if (!params.limits) return { error: "limits required for set action" };

        const defaults = {
          daily_entries: 100,
          profile_notes: 50,
          graph_entities: 500,
          graph_edges: 1000,
          session_messages: 200,
        };

        const budget = { ...defaults, ...params.limits };

        await pool.query(
          `INSERT INTO agent_memory_budgets (uid, agent_id, limits, created_at, updated_at)
           VALUES ($1, $2, $3::jsonb, NOW(), NOW())
           ON CONFLICT (uid, agent_id)
           DO UPDATE SET limits = $3::jsonb, updated_at = NOW()`,
          [ctx.uid, targetAgentId, JSON.stringify(budget)],
        );

        return { result: "Memory budget set", agentId: targetAgentId, limits: budget };
      }

      case "check": {
        // Get budget limits
        const { rows: budgetRows } = await pool.query<{
          limits: Record<string, number>;
        }>(
          "SELECT limits FROM agent_memory_budgets WHERE uid = $1 AND agent_id = $2",
          [ctx.uid, targetAgentId],
        );

        const limits = budgetRows.length > 0
          ? budgetRows[0]!.limits
          : { daily_entries: 100, profile_notes: 50, graph_entities: 500, graph_edges: 1000, session_messages: 200 };

        // Get actual usage
        const today = new Date().toISOString().split("T")[0];

        const [dailyResult, profileResult, entityResult, edgeResult] = await Promise.all([
          pool.query<{ count: string }>(
            `SELECT COALESCE(jsonb_array_length(entries), 0) AS count
             FROM daily_memory WHERE user_id = $1 AND date = $2`,
            [ctx.uid, today],
          ),
          pool.query<{ count: string }>(
            `SELECT COALESCE(jsonb_array_length(profile_data->'strategicNotes'), 0) AS count
             FROM memory_profiles WHERE user_id = $1`,
            [ctx.uid],
          ),
          pool.query<{ count: string }>(
            "SELECT COUNT(*)::text AS count FROM graph_entities WHERE uid = $1",
            [ctx.uid],
          ),
          pool.query<{ count: string }>(
            "SELECT COUNT(*)::text AS count FROM graph_edges WHERE uid = $1",
            [ctx.uid],
          ),
        ]);

        const usage = {
          daily_entries: parseInt(dailyResult.rows[0]?.count ?? "0"),
          profile_notes: parseInt(profileResult.rows[0]?.count ?? "0"),
          graph_entities: parseInt(entityResult.rows[0]?.count ?? "0"),
          graph_edges: parseInt(edgeResult.rows[0]?.count ?? "0"),
        };

        const overBudget: string[] = [];
        for (const [key, used] of Object.entries(usage)) {
          const limit = (limits as Record<string, number>)[key];
          if (limit && used > limit) {
            overBudget.push(`${key}: ${used}/${limit}`);
          }
        }

        return {
          agentId: targetAgentId,
          limits,
          usage,
          overBudget: overBudget.length > 0 ? overBudget : undefined,
          healthy: overBudget.length === 0,
        };
      }

      case "enforce": {
        // Get budget and usage, then compact anything over limit
        const { rows: budgetRows } = await pool.query<{
          limits: Record<string, number>;
        }>(
          "SELECT limits FROM agent_memory_budgets WHERE uid = $1 AND agent_id = $2",
          [ctx.uid, targetAgentId],
        );

        if (budgetRows.length === 0) return { result: "No budget set — nothing to enforce" };

        const limits = budgetRows[0]!.limits;
        const actions: string[] = [];

        // Enforce daily entry limit — prune oldest entries
        const dailyLimit = limits.daily_entries ?? 100;
        const today = new Date().toISOString().split("T")[0];
        const { rows: dailyRows } = await pool.query<{ entries: unknown[] }>(
          "SELECT entries FROM daily_memory WHERE user_id = $1 AND date = $2",
          [ctx.uid, today],
        );

        if (dailyRows.length > 0) {
          const entries = dailyRows[0]!.entries as unknown[];
          if (entries.length > dailyLimit) {
            const trimmed = entries.slice(-dailyLimit);
            await pool.query(
              "UPDATE daily_memory SET entries = $1::jsonb, updated_at = NOW() WHERE user_id = $2 AND date = $3",
              [JSON.stringify(trimmed), ctx.uid, today],
            );
            actions.push(`Trimmed daily entries: ${entries.length} → ${trimmed.length}`);
          }
        }

        // Enforce graph entity limit — prune lowest reinforcement score
        const entityLimit = limits.graph_entities ?? 500;
        const { rows: entityCountRows } = await pool.query<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM graph_entities WHERE uid = $1",
          [ctx.uid],
        );
        const entityCount = parseInt(entityCountRows[0]?.count ?? "0");

        if (entityCount > entityLimit) {
          const toDelete = entityCount - entityLimit;
          await pool.query(
            `DELETE FROM graph_entities WHERE id IN (
               SELECT id FROM graph_entities WHERE uid = $1
               ORDER BY reinforcement_score ASC, last_accessed_at ASC
               LIMIT $2
             )`,
            [ctx.uid, toDelete],
          );
          actions.push(`Pruned ${toDelete} low-score graph entities`);
        }

        return {
          result: actions.length > 0 ? "Budget enforced" : "All within budget",
          agentId: targetAgentId,
          actions,
        };
      }

      case "list": {
        const { rows } = await pool.query<{
          agent_id: string;
          limits: Record<string, number>;
        }>(
          "SELECT agent_id, limits FROM agent_memory_budgets WHERE uid = $1",
          [ctx.uid],
        );

        return {
          result: `${rows.length} budget(s) configured`,
          budgets: rows.map((r) => ({ agentId: r.agent_id, limits: r.limits })),
        };
      }

      default:
        return { error: "Unknown action" };
    }
  },
});
