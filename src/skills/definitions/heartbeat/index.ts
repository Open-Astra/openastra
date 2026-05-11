import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { getPool } from "../../../config/postgres.js";

// ── Heartbeat Skill ─────────────────────────────────────────────────
// Persistent scheduled agent wake-ups. Agents define heartbeats with
// cron expressions and task messages. The scheduler picks them up
// and triggers autonomous agent runs.
//
// This is the Astra equivalent of OpenClaw's heartbeat system —
// but database-backed, multi-agent, and integrated with the
// autonomous execution pipeline.
//
// Flow:
//   1. Agent creates a heartbeat via `heartbeat_create`
//   2. Heartbeat stored in Postgres with cron + agent config
//   3. Cron scheduler loads heartbeats on startup and schedules them
//   4. On trigger: calls runAutonomousAgent with the task message
//   5. Results logged to `heartbeat_runs` table

const CreateHeartbeatParams = z.object({
  name: z.string().describe("Unique heartbeat name (e.g. 'check-emails', 'market-scan')"),
  cronExpression: z.string().describe("Cron expression (e.g. '*/30 * * * *' for every 30 min)"),
  taskMessage: z.string().describe("Message/prompt sent to the agent when heartbeat fires"),
  agentId: z.string().describe("Agent ID to run the task"),
  enabled: z.boolean().default(true),
  maxRuntime: z.number().int().min(10).max(300).default(60).describe("Max runtime in seconds"),
});

const ListHeartbeatsParams = z.object({
  includeDisabled: z.boolean().default(false),
});

const UpdateHeartbeatParams = z.object({
  name: z.string().describe("Heartbeat name to update"),
  enabled: z.boolean().optional().describe("Enable/disable"),
  cronExpression: z.string().optional().describe("New cron expression"),
  taskMessage: z.string().optional().describe("New task message"),
});

const DeleteHeartbeatParams = z.object({
  name: z.string().describe("Heartbeat name to delete"),
});

const HeartbeatHistoryParams = z.object({
  name: z.string().optional().describe("Filter by heartbeat name"),
  limit: z.number().int().min(1).max(50).default(10),
});

const ENSURE_TABLES = `
CREATE TABLE IF NOT EXISTS heartbeats (
  id SERIAL PRIMARY KEY,
  uid TEXT NOT NULL,
  name TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  task_message TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  enabled BOOLEAN DEFAULT TRUE,
  max_runtime INTEGER DEFAULT 60,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  run_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(uid, name)
);
CREATE TABLE IF NOT EXISTS heartbeat_runs (
  id SERIAL PRIMARY KEY,
  heartbeat_id INTEGER REFERENCES heartbeats(id),
  uid TEXT NOT NULL,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status TEXT DEFAULT 'running',
  result_summary TEXT,
  token_usage JSONB,
  error TEXT
)`;

const heartbeatSkill: SkillDefinition = {
  name: "heartbeat",
  version: "1.0.0",

  manifest: {
    id: "heartbeat",
    name: "Heartbeat",
    description: "Persistent scheduled agent wake-ups. Create cron-based heartbeats that proactively trigger agent runs.",
    category: "execute",
    tools: ["heartbeat_create", "heartbeat_list", "heartbeat_update", "heartbeat_delete", "heartbeat_history"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    let tablesReady = false;
    const ensureTables = async () => {
      if (tablesReady) return;
      await getPool().query(ENSURE_TABLES);
      tablesReady = true;
    };

    // Calculate next run time from cron (simplified)
    const describeSchedule = (cron: string): string => {
      const parts = cron.split(/\s+/);
      if (parts.length !== 5) return cron;

      const [min, hour, dom, , dow] = parts;
      if (min === "*" && hour === "*") return "every minute";
      if (min?.startsWith("*/")) return `every ${min.slice(2)} minutes`;
      if (hour?.startsWith("*/")) return `every ${hour.slice(2)} hours at minute ${min}`;
      if (dow === "1-5") return `weekdays at ${hour}:${min?.padStart(2, "0")}`;
      if (dom === "*" && dow === "*") return `daily at ${hour}:${min?.padStart(2, "0")}`;
      return cron;
    };

    ctx.registerTool({
      name: "heartbeat_create",
      description: "Create a new heartbeat — a persistent scheduled agent wake-up. The agent will be triggered on the cron schedule with the specified task message.",
      parameters: CreateHeartbeatParams,

      async execute(params, toolCtx) {
        await ensureTables();
        const result = await getPool().query(
          `INSERT INTO heartbeats (uid, name, cron_expression, task_message, agent_id, enabled, max_runtime)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (uid, name) DO UPDATE SET
             cron_expression = $3, task_message = $4, agent_id = $5, enabled = $6, max_runtime = $7, updated_at = NOW()
           RETURNING id`,
          [toolCtx.uid, params.name, params.cronExpression, params.taskMessage, params.agentId, params.enabled, params.maxRuntime],
        );

        return {
          success: true,
          heartbeatId: (result.rows[0] as { id: number }).id,
          name: params.name,
          schedule: describeSchedule(params.cronExpression),
          cronExpression: params.cronExpression,
          agentId: params.agentId,
          taskMessage: params.taskMessage,
          enabled: params.enabled,
          note: "Heartbeat registered. The scheduler will pick it up and trigger autonomous agent runs on schedule.",
        };
      },
    });

    ctx.registerTool({
      name: "heartbeat_list",
      description: "List all heartbeats for the current user.",
      parameters: ListHeartbeatsParams,

      async execute(params, toolCtx) {
        await ensureTables();
        const enabledFilter = params.includeDisabled ? "" : "AND enabled = true";
        const result = await getPool().query(
          `SELECT id, name, cron_expression, task_message, agent_id, enabled, max_runtime,
                  last_run_at, run_count, created_at
           FROM heartbeats WHERE uid = $1 ${enabledFilter}
           ORDER BY created_at DESC`,
          [toolCtx.uid],
        );

        return {
          count: result.rows.length,
          heartbeats: (result.rows as Array<{
            id: number; name: string; cron_expression: string; task_message: string;
            agent_id: string; enabled: boolean; max_runtime: number;
            last_run_at: Date | null; run_count: number; created_at: Date;
          }>).map((h) => ({
            ...h,
            schedule: describeSchedule(h.cron_expression),
            taskMessage: h.task_message.slice(0, 100),
          })),
        };
      },
    });

    ctx.registerTool({
      name: "heartbeat_update",
      description: "Update a heartbeat's schedule, task, or enabled state.",
      parameters: UpdateHeartbeatParams,

      async execute(params, toolCtx) {
        await ensureTables();
        const sets: string[] = ["updated_at = NOW()"];
        const queryParams: unknown[] = [];
        let idx = 1;

        if (params.enabled !== undefined) { sets.push(`enabled = $${idx}`); queryParams.push(params.enabled); idx++; }
        if (params.cronExpression) { sets.push(`cron_expression = $${idx}`); queryParams.push(params.cronExpression); idx++; }
        if (params.taskMessage) { sets.push(`task_message = $${idx}`); queryParams.push(params.taskMessage); idx++; }

        queryParams.push(params.name, toolCtx.uid);

        const result = await getPool().query(
          `UPDATE heartbeats SET ${sets.join(", ")} WHERE name = $${idx} AND uid = $${idx + 1} RETURNING id, name, enabled`,
          queryParams,
        );

        return result.rowCount! > 0
          ? { success: true, updated: result.rows[0] }
          : { error: `Heartbeat "${params.name}" not found.` };
      },
    });

    ctx.registerTool({
      name: "heartbeat_delete",
      description: "Delete a heartbeat and all its run history.",
      parameters: DeleteHeartbeatParams,

      async execute(params, toolCtx) {
        await ensureTables();
        // Delete runs first (FK constraint)
        await getPool().query(
          `DELETE FROM heartbeat_runs WHERE heartbeat_id IN (SELECT id FROM heartbeats WHERE name = $1 AND uid = $2)`,
          [params.name, toolCtx.uid],
        );

        const result = await getPool().query(
          `DELETE FROM heartbeats WHERE name = $1 AND uid = $2`,
          [params.name, toolCtx.uid],
        );

        return result.rowCount! > 0
          ? { success: true, deleted: params.name }
          : { error: `Heartbeat "${params.name}" not found.` };
      },
    });

    ctx.registerTool({
      name: "heartbeat_history",
      description: "View recent heartbeat execution history.",
      parameters: HeartbeatHistoryParams,

      async execute(params, toolCtx) {
        await ensureTables();
        const nameFilter = params.name ? "AND h.name = $3" : "";
        const queryParams: unknown[] = [toolCtx.uid, params.limit];
        if (params.name) queryParams.push(params.name);

        const result = await getPool().query(
          `SELECT r.id, h.name, r.started_at, r.completed_at, r.status, r.result_summary, r.error
           FROM heartbeat_runs r
           JOIN heartbeats h ON h.id = r.heartbeat_id
           WHERE r.uid = $1 ${nameFilter}
           ORDER BY r.started_at DESC LIMIT $2`,
          queryParams,
        );

        return {
          count: result.rows.length,
          runs: result.rows as Array<{
            id: number; name: string; started_at: Date; completed_at: Date | null;
            status: string; result_summary: string | null; error: string | null;
          }>,
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "heartbeat",
      instructions: `You have a heartbeat system for proactive scheduled tasks. Use:
- \`heartbeat_create\` — schedule recurring agent wake-ups with cron expressions
- \`heartbeat_list\` — view all active heartbeats
- \`heartbeat_update\` — modify schedule, task, or enable/disable
- \`heartbeat_delete\` — remove a heartbeat
- \`heartbeat_history\` — view execution history

Heartbeats persist in Postgres and survive restarts. The scheduler triggers autonomous agent runs on schedule. Use cases: check emails, scan markets, monitor RSS feeds, deliver reminders, run maintenance tasks.`,
    };
  },
};

export default heartbeatSkill;
