import { z } from "zod";
import { registerTool } from "./registry.js";
import { readBlackboard, getBlackboardSummary } from "../agents/blackboard.js";
import { getPool } from "../config/postgres.js";

// ── swarm_observe ───────────────────────────────────────────────────
// Lightweight read-only observer that monitors a running or completed
// swarm. Generates summaries, tracks progress, and fires alerts
// when anomalies are detected (budget overruns, stuck agents, conflicts).

const SwarmObserveParams = z.object({
  action: z
    .enum(["status", "summary", "alerts", "timeline"])
    .describe("What to observe: current status, full summary, alert anomalies, or execution timeline"),
  swarm_id: z
    .string()
    .describe("ID of the swarm to observe"),
});

registerTool({
  name: "swarm_observe",
  description:
    "Read-only observer for swarm monitoring. Get swarm status, blackboard summary, anomaly alerts, or execution timeline without affecting the running swarm.",
  parameters: SwarmObserveParams,

  async execute(params, ctx) {
    const pool = getPool();

    switch (params.action) {
      case "status": {
        const { rows } = await pool.query<{
          id: string;
          status: string;
          config: {
            rootTask: string;
            agents: Record<string, { status: string; roleId: string; usage?: { totalTokens: number } }>;
            tasks: Record<string, { roleId: string; description: string }>;
          };
          created_at: string;
          updated_at: string;
        }>(
          "SELECT id, status, config, created_at, updated_at FROM swarms WHERE id = $1 AND owner_id = $2",
          [params.swarm_id, ctx.uid],
        );

        if (rows.length === 0) return { error: "Swarm not found" };

        const swarm = rows[0]!;
        const agents = swarm.config.agents ?? {};
        const agentStatuses = Object.values(agents).map((a) => ({
          role: a.roleId,
          status: a.status,
          tokens: a.usage?.totalTokens ?? 0,
        }));

        return {
          swarmId: swarm.id,
          status: swarm.status,
          rootTask: swarm.config.rootTask?.slice(0, 200),
          agentCount: agentStatuses.length,
          agents: agentStatuses,
          createdAt: swarm.created_at,
          updatedAt: swarm.updated_at,
        };
      }

      case "summary": {
        const summary = await getBlackboardSummary(ctx.uid, params.swarm_id);
        return { swarmId: params.swarm_id, blackboardSummary: summary };
      }

      case "alerts": {
        const { rows } = await pool.query<{
          config: {
            agents: Record<string, { status: string; roleId: string; usage?: { totalTokens: number; durationMs: number } }>;
          };
          status: string;
        }>(
          "SELECT config, status FROM swarms WHERE id = $1 AND owner_id = $2",
          [params.swarm_id, ctx.uid],
        );

        if (rows.length === 0) return { error: "Swarm not found" };

        const alerts: Array<{ level: string; message: string }> = [];
        const agents = rows[0]!.config.agents ?? {};

        for (const [id, agent] of Object.entries(agents)) {
          if (agent.status === "failed") {
            alerts.push({ level: "critical", message: `Agent ${agent.roleId} (${id.slice(0, 8)}) failed` });
          }
          if (agent.status === "timeout") {
            alerts.push({ level: "warning", message: `Agent ${agent.roleId} (${id.slice(0, 8)}) timed out` });
          }
          if (agent.usage && agent.usage.totalTokens > 50_000) {
            alerts.push({ level: "warning", message: `Agent ${agent.roleId} used ${agent.usage.totalTokens} tokens (high)` });
          }
        }

        // Check for blackboard conflicts
        const entries = await readBlackboard(ctx.uid, params.swarm_id);
        const disputed = entries.filter((e) => e.status === "disputed");
        if (disputed.length > 0) {
          alerts.push({ level: "warning", message: `${disputed.length} disputed blackboard entries` });
        }

        if (rows[0]!.status === "failed") {
          alerts.push({ level: "critical", message: "Swarm execution failed" });
        }

        return { swarmId: params.swarm_id, alertCount: alerts.length, alerts };
      }

      case "timeline": {
        const entries = await readBlackboard(ctx.uid, params.swarm_id);

        const timeline = entries
          .sort((a, b) => a.timestamp - b.timestamp)
          .map((e) => ({
            time: new Date(e.timestamp).toISOString(),
            agent: e.agentRole,
            section: e.section,
            contentPreview: e.content.slice(0, 150),
            version: e.version,
            status: e.status,
          }));

        return { swarmId: params.swarm_id, events: timeline.length, timeline };
      }

      default:
        return { error: "Unknown action" };
    }
  },
});
