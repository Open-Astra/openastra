import { z } from "zod";
import { registerTool } from "./registry.js";
import { delegateTask } from "../agents/delegation.js";

// ── delegate_task ─────────────────────────────────────────────────────
// Delegates a task to another agent asynchronously, returning a taskId.

const Params = z.object({
  message: z.string().min(1).describe("Message or task description to send to the target agent"),
  agentId: z.string().describe("ID of the agent to delegate the task to"),
  callbackUrl: z.string().url().optional().describe("Optional URL to call back when the task completes"),
});

registerTool({
  name: "delegate_task",
  description: "Delegates a task to another agent asynchronously, returning a taskId immediately. Use tool_poll to check completion.",
  parameters: Params,
  async: true,
  async execute(params, ctx) {
    if (!ctx.workspaceId) {
      return { error: "Workspace required for task delegation" };
    }
    return delegateTask(params.message, params.agentId, ctx.workspaceId, ctx.uid, {
      callbackUrl: params.callbackUrl,
      delegatedBy: ctx.agentId,
    });
  },
});
