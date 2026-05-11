import { z } from "zod";
import { registerTool } from "./registry.js";
import {
  startResearch,
  getResearchTask,
  listResearchTasks,
  pauseResearch,
  resumeResearch,
} from "../agents/deep-research.js";
import { getInferenceClientForAgent } from "../inference/factory.js";
import { getAgentConfig } from "../config/agents.js";

// ── research_manage ──────────────────────────────────────────────────
// Manage deep research tasks: start, check status, pause, resume.

const ResearchManageParams = z.object({
  action: z
    .enum(["start", "status", "list", "pause", "resume"])
    .describe("Action: start new research, check status, list tasks, pause, or resume"),
  topic: z
    .string()
    .optional()
    .describe("Research topic (required for start action)"),
  taskId: z
    .string()
    .optional()
    .describe("Task ID (required for status/pause/resume)"),
  depth: z
    .enum(["shallow", "moderate", "deep", "exhaustive"])
    .optional()
    .default("moderate")
    .describe("Research depth (default: moderate)"),
  maxDurationHours: z
    .number()
    .optional()
    .default(24)
    .describe("Max research duration in hours (default: 24)"),
});

registerTool({
  name: "research_manage",
  description:
    "Start and manage deep autonomous research tasks. Research runs for hours or days, iteratively searching and synthesizing information like a PhD researcher.",
  parameters: ResearchManageParams,

  async execute(params, ctx) {
    switch (params.action) {
      case "start": {
        if (!params.topic) {
          return { error: "topic is required to start research" };
        }
        const agentConfig = getAgentConfig("researcher");
        let client;
        try {
          client = getInferenceClientForAgent(agentConfig);
        } catch {
          // Researcher's provider unavailable — fall back to calling agent's provider
          const callerConfig = getAgentConfig(ctx.agentId);
          client = getInferenceClientForAgent(callerConfig);
        }
        const task = await startResearch(ctx.uid, params.topic, {
          depth: params.depth,
          maxDurationHours: params.maxDurationHours,
        }, client);
        return {
          result: `Research started: "${params.topic}"`,
          taskId: task.id,
          questions: task.questions,
          depth: params.depth,
          estimatedIterations: task.progress.totalIterations,
        };
      }

      case "status": {
        if (!params.taskId) {
          return { error: "taskId is required for status check" };
        }
        const task = await getResearchTask(params.taskId);
        if (!task) return { error: "Research task not found" };
        return {
          result: `Research: "${task.topic}"`,
          status: task.status,
          progress: task.progress,
          findingsCount: task.findings.length,
          report: task.report ? task.report.slice(0, 2000) : undefined,
        };
      }

      case "list": {
        const tasks = await listResearchTasks(ctx.uid);
        return {
          result: `${tasks.length} research task(s)`,
          tasks: tasks.map((t) => ({
            id: t.id,
            topic: t.topic,
            status: t.status,
            progress: `${t.progress.completedIterations}/${t.progress.totalIterations}`,
          })),
        };
      }

      case "pause": {
        if (!params.taskId) return { error: "taskId required" };
        await pauseResearch(params.taskId);
        return { result: `Research ${params.taskId} paused.` };
      }

      case "resume": {
        if (!params.taskId) return { error: "taskId required" };
        await resumeResearch(params.taskId);
        return { result: `Research ${params.taskId} resumed.` };
      }

      default:
        return { error: "Unknown action" };
    }
  },
});
