import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── Discord Integration Skill ───────────────────────────────────────
// Send messages, read channels, and manage Discord interactions via
// the Discord REST API. Requires DISCORD_BOT_TOKEN.

const DISCORD_API = "https://discord.com/api/v10";

const SendMessageParams = z.object({
  channelId: z.string().describe("Discord channel ID"),
  content: z.string().max(2000).describe("Message content (max 2000 chars)"),
});

const ReadChannelParams = z.object({
  channelId: z.string().describe("Discord channel ID"),
  limit: z.number().int().min(1).max(100).default(20).describe("Number of messages to fetch"),
});

const ListGuildsParams = z.object({});

const discordSkill: SkillDefinition = {
  name: "discord_integration",
  version: "1.0.0",

  manifest: {
    id: "discord_integration",
    name: "Discord Integration",
    description: "Send messages, read channels, and list servers via Discord REST API.",
    category: "communicate",
    tools: ["discord_send", "discord_read_channel", "discord_list_guilds"],
    configFields: [
      { name: "botToken", type: "string", required: true, description: "Discord Bot Token", envVar: "DISCORD_BOT_TOKEN" },
    ],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    const getHeaders = () => {
      const token = process.env.DISCORD_BOT_TOKEN;
      if (!token) throw new Error("DISCORD_BOT_TOKEN not configured.");
      return { "Authorization": `Bot ${token}`, "Content-Type": "application/json" };
    };

    ctx.registerTool({
      name: "discord_send",
      description: "Send a message to a Discord channel.",
      parameters: SendMessageParams,

      async execute(params) {
        try {
          const res = await safeFetch(`${DISCORD_API}/channels/${params.channelId}/messages`, {
            method: "POST",
            headers: getHeaders(),
            body: JSON.stringify({ content: params.content }),
            ssrfProtection: false,
          });

          if (!res.ok) {
            const err = await res.text();
            return { error: `Discord API error ${res.status}: ${err.slice(0, 200)}` };
          }

          const data = (await res.json()) as { id: string; channel_id: string };
          return { success: true, messageId: data.id, channelId: data.channel_id };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    });

    ctx.registerTool({
      name: "discord_read_channel",
      description: "Read recent messages from a Discord channel.",
      parameters: ReadChannelParams,

      async execute(params) {
        try {
          const url = `${DISCORD_API}/channels/${params.channelId}/messages?limit=${params.limit}`;
          const res = await safeFetch(url, { headers: getHeaders(), ssrfProtection: false });

          if (!res.ok) return { error: `Discord API error ${res.status}` };

          const messages = (await res.json()) as Array<{ id: string; author: { username: string }; content: string; timestamp: string }>;
          return {
            channelId: params.channelId,
            count: messages.length,
            messages: messages.map((m) => ({
              id: m.id,
              author: m.author.username,
              content: m.content?.slice(0, 500),
              timestamp: m.timestamp,
            })),
          };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    });

    ctx.registerTool({
      name: "discord_list_guilds",
      description: "List Discord servers (guilds) the bot is a member of.",
      parameters: ListGuildsParams,

      async execute() {
        try {
          const res = await safeFetch(`${DISCORD_API}/users/@me/guilds`, {
            headers: getHeaders(),
            ssrfProtection: false,
          });

          if (!res.ok) return { error: `Discord API error ${res.status}` };

          const guilds = (await res.json()) as Array<{ id: string; name: string; icon: string | null; owner: boolean; member_count?: number }>;
          return {
            count: guilds.length,
            guilds: guilds.map((g) => ({
              id: g.id,
              name: g.name,
              isOwner: g.owner,
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
      skillId: "discord_integration",
      instructions: "You can interact with Discord using `discord_send` (post messages), `discord_read_channel` (read history), and `discord_list_guilds` (list servers). Requires DISCORD_BOT_TOKEN.",
    };
  },
};

export default discordSkill;
