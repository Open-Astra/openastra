import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── Notify User Skill ─────────────────────────────────────────────
// Sends a notification to the user. Currently logs the notification
// server-side — in production, would integrate with a push
// notification system (FCM, APNs, WebSocket, etc.).

const NotifyUserParams = z.object({
  message: z.string().describe("Notification message body"),
  title: z.string().optional().describe("Optional notification title"),
});

const notifyUserSkill: SkillDefinition = {
  name: "notify_user",
  version: "1.0.0",

  manifest: {
    id: "notify_user",
    name: "Notify User",
    description: "Sends a notification to the user. Currently logs server-side — push notification integration required for production.",
    category: "communicate",
    tools: ["notify_user"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "notify_user",
      description: "Send a notification to the user. Currently logs the notification server-side. In production, this would deliver via push notifications, email, or WebSocket.",
      parameters: NotifyUserParams,

      async execute(params, toolCtx) {
        const timestamp = new Date().toISOString();
        const title = params.title ?? "Notification";

        ctx.logger.info(
          `[notify_user] uid=${toolCtx.uid} agent=${toolCtx.agentId} title="${title}" message="${params.message}"`,
        );

        return {
          success: true,
          notification: {
            title,
            message: params.message,
            timestamp,
            userId: toolCtx.uid,
            agentId: toolCtx.agentId,
          },
          note: "Notification logged server-side. Configure push notification service for user delivery.",
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "notify_user",
      instructions: "You can send notifications to the user using the `notify_user` tool. Provide a message and optional title.",
    };
  },
};

export default notifyUserSkill;
