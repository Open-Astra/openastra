import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── Schedule Task Skill ───────────────────────────────────────────
// In-memory scheduled task store. Tasks are stored with cron
// expressions but execution is a placeholder — in production
// this would integrate with a job scheduler.

interface ScheduledTask {
  name: string;
  cronExpression: string;
  agentId: string;
  taskMessage: string;
  createdAt: string;
}

const tasks = new Map<string, ScheduledTask>();

const ScheduleTaskParams = z.object({
  name: z.string().describe("Unique name for the scheduled task"),
  cronExpression: z.string().describe("Cron expression for scheduling (e.g. '0 9 * * *' for daily at 9am)"),
  agentId: z.string().describe("ID of the agent to run the task"),
  taskMessage: z.string().describe("Message/prompt to send to the agent when the task fires"),
});

const ListTasksParams = z.object({});

const CancelTaskParams = z.object({
  name: z.string().describe("Name of the scheduled task to cancel"),
});

const scheduleTaskSkill: SkillDefinition = {
  name: "schedule_task",
  version: "1.0.0",

  manifest: {
    id: "schedule_task",
    name: "Schedule Task",
    description: "Schedule, list, and cancel recurring tasks. Tasks are stored in memory with cron expressions.",
    category: "execute",
    tools: ["schedule_task", "list_scheduled_tasks", "cancel_scheduled_task"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "schedule_task",
      description: "Schedule a recurring task with a cron expression. The specified agent will receive the task message on the schedule.",
      parameters: ScheduleTaskParams,

      async execute(params) {
        if (tasks.has(params.name)) {
          return { error: `A task with name "${params.name}" already exists. Cancel it first or use a different name.` };
        }

        const task: ScheduledTask = {
          name: params.name,
          cronExpression: params.cronExpression,
          agentId: params.agentId,
          taskMessage: params.taskMessage,
          createdAt: new Date().toISOString(),
        };

        tasks.set(params.name, task);

        return {
          success: true,
          task,
          note: "Task scheduled in memory. In production, this would be registered with a persistent job scheduler.",
        };
      },
    });

    ctx.registerTool({
      name: "list_scheduled_tasks",
      description: "List all currently scheduled tasks.",
      parameters: ListTasksParams,

      async execute() {
        const allTasks = [...tasks.values()];
        return {
          count: allTasks.length,
          tasks: allTasks,
        };
      },
    });

    ctx.registerTool({
      name: "cancel_scheduled_task",
      description: "Cancel a scheduled task by name.",
      parameters: CancelTaskParams,

      async execute(params) {
        const task = tasks.get(params.name);
        if (!task) {
          return { error: `No scheduled task found with name "${params.name}".` };
        }

        tasks.delete(params.name);

        return {
          success: true,
          cancelled: task,
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "schedule_task",
      instructions: "You can schedule recurring tasks using `schedule_task`, view them with `list_scheduled_tasks`, and remove them with `cancel_scheduled_task`.",
    };
  },
};

export default scheduleTaskSkill;
