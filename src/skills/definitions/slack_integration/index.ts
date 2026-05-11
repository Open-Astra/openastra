import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── Slack Integration Skill ─────────────────────────────────────────
// Send messages, read channels, and manage threads via Slack Web API.
// Requires SLACK_BOT_TOKEN (xoxb-...).

const SLACK_API = "https://slack.com/api";

const SendMessageParams = z.object({
  channel: z.string().describe("Channel ID or name (e.g. #general or C01234567)"),
  text: z.string().describe("Message text (supports Slack markdown)"),
  threadTs: z.string().optional().describe("Thread timestamp to reply in a thread"),
});

const ReadChannelParams = z.object({
  channel: z.string().describe("Channel ID"),
  limit: z.number().int().min(1).max(100).default(20).describe("Number of messages to fetch"),
});

const ListChannelsParams = z.object({
  limit: z.number().int().min(1).max(200).default(50).describe("Max channels to list"),
  types: z.string().default("public_channel,private_channel").describe("Channel types to list"),
});

const slackSkill: SkillDefinition = {
  name: "slack_integration",
  version: "1.0.0",

  manifest: {
    id: "slack_integration",
    name: "Slack Integration",
    description: "Send messages, read channels, and list channels via Slack Web API.",
    category: "communicate",
    tools: ["slack_send", "slack_read_channel", "slack_list_channels"],
    configFields: [
      { name: "botToken", type: "string", required: true, description: "Slack Bot Token (xoxb-...)", envVar: "SLACK_BOT_TOKEN" },
    ],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    const getToken = () => process.env.SLACK_BOT_TOKEN;

    const slackApi = async (method: string, body: Record<string, unknown>) => {
      const token = getToken();
      if (!token) throw new Error("SLACK_BOT_TOKEN not configured.");

      const res = await safeFetch(`${SLACK_API}/${method}`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        ssrfProtection: false,
      });

      return (await res.json()) as { ok: boolean; error?: string; [key: string]: unknown };
    };

    ctx.registerTool({
      name: "slack_send",
      description: "Send a message to a Slack channel or thread.",
      parameters: SendMessageParams,

      async execute(params) {
        try {
          const body: Record<string, unknown> = { channel: params.channel, text: params.text };
          if (params.threadTs) body.thread_ts = params.threadTs;

          const data = await slackApi("chat.postMessage", body);
          if (!data.ok) return { error: `Slack API error: ${data.error}` };

          return { success: true, channel: params.channel, ts: data.ts };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    });

    ctx.registerTool({
      name: "slack_read_channel",
      description: "Read recent messages from a Slack channel.",
      parameters: ReadChannelParams,

      async execute(params) {
        try {
          const data = await slackApi("conversations.history", { channel: params.channel, limit: params.limit });
          if (!data.ok) return { error: `Slack API error: ${data.error}` };

          const messages = (data.messages as Array<{ user: string; text: string; ts: string; thread_ts?: string }>) ?? [];
          return {
            channel: params.channel,
            count: messages.length,
            messages: messages.map((m) => ({
              user: m.user,
              text: m.text?.slice(0, 500),
              ts: m.ts,
              isThread: !!m.thread_ts,
            })),
          };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    });

    ctx.registerTool({
      name: "slack_list_channels",
      description: "List available Slack channels.",
      parameters: ListChannelsParams,

      async execute(params) {
        try {
          const data = await slackApi("conversations.list", { limit: params.limit, types: params.types });
          if (!data.ok) return { error: `Slack API error: ${data.error}` };

          const channels = (data.channels as Array<{ id: string; name: string; is_private: boolean; num_members: number; topic?: { value: string } }>) ?? [];
          return {
            count: channels.length,
            channels: channels.map((c) => ({
              id: c.id,
              name: c.name,
              isPrivate: c.is_private,
              members: c.num_members,
              topic: c.topic?.value?.slice(0, 100),
            })),
          };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "slack_integration",
      instructions: "You can interact with Slack using `slack_send` (post messages), `slack_read_channel` (read history), and `slack_list_channels` (discover channels). Requires SLACK_BOT_TOKEN.",
    };
  },
};

export default slackSkill;
