import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { getPool } from "../../../config/postgres.js";

// ── Reminder Skill ──────────────────────────────────────────────────
// Persistent reminders stored in Postgres. Can be queried by the
// heartbeat system or scheduler for delivery.

const CreateReminderParams = z.object({
  message: z.string().describe("Reminder message"),
  remindAt: z.string().describe("When to remind (ISO 8601 datetime)"),
  recurring: z.string().optional().describe("Cron expression for recurring reminders"),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
});

const ListRemindersParams = z.object({
  status: z.enum(["pending", "delivered", "all"]).default("pending"),
  limit: z.number().int().min(1).max(50).default(20),
});

const DismissReminderParams = z.object({
  id: z.number().int().describe("Reminder ID to dismiss"),
});

const ENSURE_TABLE = `
CREATE TABLE IF NOT EXISTS reminders (
  id SERIAL PRIMARY KEY,
  uid TEXT NOT NULL,
  message TEXT NOT NULL,
  remind_at TIMESTAMPTZ NOT NULL,
  recurring TEXT,
  priority TEXT DEFAULT 'normal',
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  delivered_at TIMESTAMPTZ
)`;

const reminderSkill: SkillDefinition = {
  name: "reminder",
  version: "1.0.0",

  manifest: {
    id: "reminder",
    name: "Reminder",
    description: "Create, list, and manage persistent reminders with optional recurring schedules.",
    category: "execute",
    tools: ["reminder_create", "reminder_list", "reminder_dismiss"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    let tableReady = false;
    const ensureTable = async () => {
      if (tableReady) return;
      await getPool().query(ENSURE_TABLE);
      tableReady = true;
    };

    ctx.registerTool({
      name: "reminder_create",
      description: "Create a new reminder. Will be stored persistently and can be picked up by the heartbeat system.",
      parameters: CreateReminderParams,

      async execute(params, toolCtx) {
        await ensureTable();
        const result = await getPool().query(
          `INSERT INTO reminders (uid, message, remind_at, recurring, priority) VALUES ($1, $2, $3, $4, $5) RETURNING id, remind_at`,
          [toolCtx.uid, params.message, params.remindAt, params.recurring ?? null, params.priority],
        );

        const row = result.rows[0] as { id: number; remind_at: Date };
        return {
          success: true,
          id: row.id,
          message: params.message,
          remindAt: row.remind_at,
          recurring: params.recurring ?? null,
          priority: params.priority,
        };
      },
    });

    ctx.registerTool({
      name: "reminder_list",
      description: "List reminders for the current user.",
      parameters: ListRemindersParams,

      async execute(params, toolCtx) {
        await ensureTable();
        const statusFilter = params.status === "all" ? "" : "AND status = $3";
        const queryParams: unknown[] = [toolCtx.uid, params.limit];
        if (params.status !== "all") queryParams.push(params.status);

        const result = await getPool().query(
          `SELECT id, message, remind_at, recurring, priority, status, created_at
           FROM reminders WHERE uid = $1 ${statusFilter}
           ORDER BY remind_at ASC LIMIT $2`,
          queryParams,
        );

        return {
          count: result.rows.length,
          reminders: result.rows as Array<{
            id: number; message: string; remind_at: Date; recurring: string | null;
            priority: string; status: string; created_at: Date;
          }>,
        };
      },
    });

    ctx.registerTool({
      name: "reminder_dismiss",
      description: "Dismiss/complete a reminder by ID.",
      parameters: DismissReminderParams,

      async execute(params, toolCtx) {
        await ensureTable();
        const result = await getPool().query(
          `UPDATE reminders SET status = 'delivered', delivered_at = NOW() WHERE id = $1 AND uid = $2 RETURNING id`,
          [params.id, toolCtx.uid],
        );

        return result.rowCount! > 0
          ? { success: true, dismissed: params.id }
          : { error: `Reminder ${params.id} not found.` };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "reminder",
      instructions: "You can manage reminders with `reminder_create` (set a reminder with datetime), `reminder_list` (view pending/delivered), and `reminder_dismiss` (mark as done). Reminders persist in Postgres.",
    };
  },
};

export default reminderSkill;
