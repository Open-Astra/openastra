import { z } from "zod";
import { registerTool } from "./registry.js";
import { getPool } from "../config/postgres.js";

// ── meta_controller ─────────────────────────────────────────────────
// Swarm meta-controller — a higher-level orchestrator that manages
// multiple independent swarms. Monitors their health, reallocates
// resource quotas, delegates overflow between swarms, and provides
// a unified dashboard.

const MetaControllerParams = z.object({
  action: z
    .enum(["dashboard", "allocate", "rebalance", "delegate", "policy", "history"])
    .describe("Action: view dashboard, allocate resources, rebalance across swarms, delegate overflow, set policy, or view history"),
  swarm_ids: z.array(z.string()).optional().describe("Swarm IDs to manage"),
  allocation: z
    .object({
      swarm_id: z.string().describe("Target swarm ID"),
      max_tokens: z.number().optional().describe("Token budget for this swarm"),
      max_agents: z.number().optional().describe("Max agents for this swarm"),
      priority: z.number().optional().describe("Priority level (higher = more resources)"),
    })
    .optional()
    .describe("Resource allocation (for allocate action)"),
  overflow_task: z.string().optional().describe("Task to delegate to another swarm (for delegate)"),
  policy: z
    .object({
      max_concurrent_swarms: z.number().optional(),
      global_token_budget: z.number().optional(),
      auto_rebalance: z.boolean().optional(),
      overflow_strategy: z.enum(["queue", "reject", "delegate"]).optional(),
    })
    .optional()
    .describe("Meta-controller policy (for policy action)"),
});

registerTool({
  name: "meta_controller",
  description:
    "Multi-swarm meta-controller. Manage multiple independent swarms with resource allocation, load balancing, overflow delegation, and unified monitoring.",
  parameters: MetaControllerParams,

  async execute(params, ctx) {
    const pool = getPool();

    switch (params.action) {
      case "dashboard": {
        // Get all swarms for this user
        const { rows: swarmRows } = await pool.query<{
          id: string;
          name: string;
          status: string;
          config: {
            rootTask: string;
            agents: Record<string, { status: string; roleId: string; usage?: { totalTokens: number } }>;
          };
          created_at: string;
          updated_at: string;
        }>(
          `SELECT id, name, status, config, created_at, updated_at
           FROM swarms WHERE owner_id = $1
           ORDER BY updated_at DESC LIMIT 20`,
          [ctx.uid],
        );

        // Get orchestrator states
        const { rows: orchRows } = await pool.query<{
          swarm_id: string;
          status: string;
          config: { usage: { totalTokens: number; durationMs: number }; errors: unknown[] };
        }>(
          `SELECT swarm_id, status, config FROM orchestrators
           WHERE agent_id = $1 ORDER BY updated_at DESC LIMIT 20`,
          [ctx.uid],
        );

        const orchMap = new Map(orchRows.map((r) => [r.swarm_id, r]));

        const swarms = swarmRows.map((s) => {
          const agents = s.config.agents ? Object.values(s.config.agents) : [];
          const orch = orchMap.get(s.id);

          return {
            id: s.id,
            name: s.name?.slice(0, 100),
            status: s.status,
            agentCount: agents.length,
            completedAgents: agents.filter((a) => a.status === "completed").length,
            failedAgents: agents.filter((a) => a.status === "failed").length,
            totalTokens: orch?.config.usage?.totalTokens ?? 0,
            errors: orch ? (orch.config.errors as unknown[]).length : 0,
            createdAt: s.created_at,
            updatedAt: s.updated_at,
          };
        });

        // Aggregate stats
        const totalSwarms = swarms.length;
        const activeSwarms = swarms.filter((s) => s.status === "executing" || s.status === "planning").length;
        const totalTokens = swarms.reduce((sum, s) => sum + s.totalTokens, 0);
        const totalAgents = swarms.reduce((sum, s) => sum + s.agentCount, 0);

        return {
          result: "Meta-controller dashboard",
          summary: {
            totalSwarms,
            activeSwarms,
            completedSwarms: swarms.filter((s) => s.status === "completed").length,
            failedSwarms: swarms.filter((s) => s.status === "failed").length,
            totalTokens,
            totalAgents,
          },
          swarms,
        };
      }

      case "allocate": {
        if (!params.allocation) return { error: "allocation required" };

        const alloc = params.allocation;
        await pool.query(
          `INSERT INTO swarm_allocations (swarm_id, uid, allocation, updated_at)
           VALUES ($1, $2, $3::jsonb, NOW())
           ON CONFLICT (swarm_id, uid)
           DO UPDATE SET allocation = $3::jsonb, updated_at = NOW()`,
          [alloc.swarm_id, ctx.uid, JSON.stringify({
            max_tokens: alloc.max_tokens ?? 100_000,
            max_agents: alloc.max_agents ?? 10,
            priority: alloc.priority ?? 5,
          })],
        );

        return {
          result: "Resources allocated",
          swarmId: alloc.swarm_id,
          allocation: alloc,
        };
      }

      case "rebalance": {
        // Get all active swarm allocations and their actual usage
        const { rows: allocRows } = await pool.query<{
          swarm_id: string;
          allocation: { max_tokens: number; max_agents: number; priority: number };
        }>(
          "SELECT swarm_id, allocation FROM swarm_allocations WHERE uid = $1",
          [ctx.uid],
        );

        const { rows: usageRows } = await pool.query<{
          id: string;
          status: string;
          config: { agents: Record<string, { usage?: { totalTokens: number } }> };
        }>(
          `SELECT id, status, config FROM swarms
           WHERE owner_id = $1 AND status IN ('executing', 'planning')`,
          [ctx.uid],
        );

        const rebalanceActions: Array<{ swarmId: string; action: string; detail: string }> = [];

        // Find underutilized and overutilized swarms
        for (const usage of usageRows) {
          const alloc = allocRows.find((a) => a.swarm_id === usage.id);
          if (!alloc) continue;

          const agents = usage.config.agents ? Object.values(usage.config.agents) : [];
          const totalTokens = agents.reduce((sum, a) => sum + (a.usage?.totalTokens ?? 0), 0);
          const utilization = totalTokens / alloc.allocation.max_tokens;

          if (utilization > 0.9) {
            rebalanceActions.push({
              swarmId: usage.id,
              action: "increase_budget",
              detail: `${Math.round(utilization * 100)}% utilized — consider increasing token budget`,
            });
          } else if (utilization < 0.2 && agents.length > 0) {
            rebalanceActions.push({
              swarmId: usage.id,
              action: "decrease_budget",
              detail: `${Math.round(utilization * 100)}% utilized — resources can be reallocated`,
            });
          }
        }

        return {
          result: "Rebalance analysis complete",
          activeSwarms: usageRows.length,
          allocatedSwarms: allocRows.length,
          actions: rebalanceActions,
        };
      }

      case "delegate": {
        if (!params.overflow_task) return { error: "overflow_task required for delegate" };

        // Find the least loaded active swarm
        const { rows: activeSwarms } = await pool.query<{
          id: string;
          status: string;
          config: { agents: Record<string, unknown> };
        }>(
          `SELECT id, status, config FROM swarms
           WHERE owner_id = $1 AND status = 'executing'
           ORDER BY updated_at DESC LIMIT 5`,
          [ctx.uid],
        );

        if (activeSwarms.length === 0) {
          return { error: "No active swarms to delegate to. Start a new swarm instead." };
        }

        // Find swarm with fewest agents
        const target = activeSwarms
          .map((s) => ({
            id: s.id,
            agentCount: s.config.agents ? Object.keys(s.config.agents).length : 0,
          }))
          .sort((a, b) => a.agentCount - b.agentCount)[0]!;

        return {
          result: "Delegation target identified",
          targetSwarmId: target.id,
          currentAgentCount: target.agentCount,
          task: params.overflow_task.slice(0, 200),
          note: "Use agent_spawn or runSwarm to execute the task within this swarm",
        };
      }

      case "policy": {
        if (!params.policy) return { error: "policy required" };

        const defaults = {
          max_concurrent_swarms: 5,
          global_token_budget: 500_000,
          auto_rebalance: true,
          overflow_strategy: "queue" as const,
        };

        const policy = { ...defaults, ...params.policy };

        await pool.query(
          `INSERT INTO meta_controller_policy (uid, policy, updated_at)
           VALUES ($1, $2::jsonb, NOW())
           ON CONFLICT (uid) DO UPDATE SET policy = $2::jsonb, updated_at = NOW()`,
          [ctx.uid, JSON.stringify(policy)],
        );

        return { result: "Meta-controller policy set", policy };
      }

      case "history": {
        const { rows } = await pool.query<{
          id: string;
          name: string;
          status: string;
          created_at: string;
          updated_at: string;
        }>(
          `SELECT id, name, status, created_at, updated_at
           FROM swarms WHERE owner_id = $1
           ORDER BY created_at DESC LIMIT 50`,
          [ctx.uid],
        );

        const statusCounts: Record<string, number> = {};
        for (const row of rows) {
          statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
        }

        return {
          result: `${rows.length} swarm(s) in history`,
          statusBreakdown: statusCounts,
          recentSwarms: rows.slice(0, 10).map((r) => ({
            id: r.id,
            name: r.name?.slice(0, 100),
            status: r.status,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
          })),
        };
      }

      default:
        return { error: "Unknown action" };
    }
  },
});
