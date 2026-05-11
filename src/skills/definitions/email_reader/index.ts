import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── Email Reader Skill ──────────────────────────────────────────────
// Reads email via IMAP-compatible REST proxy or direct IMAP.
// Supports fetching inbox, searching, and reading individual messages.
// Requires EMAIL_IMAP_HOST, EMAIL_IMAP_USER, EMAIL_IMAP_PASS env vars
// or an EMAIL_API_URL for a REST-based email proxy.

const FetchInboxParams = z.object({
  folder: z.string().default("INBOX").describe("Mail folder to read (default: INBOX)"),
  limit: z.number().int().min(1).max(50).default(10).describe("Number of messages to fetch"),
  unreadOnly: z.boolean().default(false).describe("Only fetch unread messages"),
});

const SearchEmailParams = z.object({
  query: z.string().describe("Search query (subject, sender, or body text)"),
  folder: z.string().default("INBOX").describe("Mail folder to search"),
  limit: z.number().int().min(1).max(20).default(10).describe("Max results"),
});

const ReadEmailParams = z.object({
  messageId: z.string().describe("Message ID to read"),
  markRead: z.boolean().default(true).describe("Mark message as read after fetching"),
});

const emailReaderSkill: SkillDefinition = {
  name: "email_reader",
  version: "1.0.0",

  manifest: {
    id: "email_reader",
    name: "Email Reader",
    description: "Read email inbox, search messages, and fetch individual emails via IMAP or REST email proxy.",
    category: "communicate",
    tools: ["email_fetch_inbox", "email_search", "email_read"],
    configFields: [
      { name: "apiUrl", type: "string", required: false, description: "Email REST proxy URL", envVar: "EMAIL_API_URL" },
      { name: "imapHost", type: "string", required: false, description: "IMAP server host", envVar: "EMAIL_IMAP_HOST" },
      { name: "imapUser", type: "string", required: false, description: "IMAP username", envVar: "EMAIL_IMAP_USER" },
      { name: "imapPass", type: "string", required: false, description: "IMAP password", envVar: "EMAIL_IMAP_PASS" },
    ],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    const getApiUrl = () => process.env.EMAIL_API_URL;

    ctx.registerTool({
      name: "email_fetch_inbox",
      description: "Fetch recent emails from inbox. Returns sender, subject, date, and preview for each message.",
      parameters: FetchInboxParams,

      async execute(params) {
        const apiUrl = getApiUrl();
        if (!apiUrl) return { error: "EMAIL_API_URL not configured. Set up an email REST proxy." };

        const url = new URL(`${apiUrl}/messages`);
        url.searchParams.set("folder", params.folder);
        url.searchParams.set("limit", String(params.limit));
        if (params.unreadOnly) url.searchParams.set("unread", "true");

        const res = await safeFetch(url.toString(), { ssrfProtection: false });
        if (!res.ok) return { error: `Email API returned ${res.status}` };

        const data = (await res.json()) as { messages: Array<{ id: string; from: string; subject: string; date: string; preview: string; read: boolean }> };
        return {
          folder: params.folder,
          count: data.messages?.length ?? 0,
          messages: (data.messages ?? []).map((m) => ({
            id: m.id,
            from: m.from,
            subject: m.subject,
            date: m.date,
            preview: m.preview?.slice(0, 200),
            read: m.read,
          })),
        };
      },
    });

    ctx.registerTool({
      name: "email_search",
      description: "Search emails by subject, sender, or body content.",
      parameters: SearchEmailParams,

      async execute(params) {
        const apiUrl = getApiUrl();
        if (!apiUrl) return { error: "EMAIL_API_URL not configured." };

        const url = new URL(`${apiUrl}/search`);
        url.searchParams.set("q", params.query);
        url.searchParams.set("folder", params.folder);
        url.searchParams.set("limit", String(params.limit));

        const res = await safeFetch(url.toString(), { ssrfProtection: false });
        if (!res.ok) return { error: `Email search returned ${res.status}` };

        const data = (await res.json()) as { results: Array<{ id: string; from: string; subject: string; date: string; snippet: string }> };
        return {
          query: params.query,
          count: data.results?.length ?? 0,
          results: data.results ?? [],
        };
      },
    });

    ctx.registerTool({
      name: "email_read",
      description: "Read the full content of a specific email by message ID.",
      parameters: ReadEmailParams,

      async execute(params) {
        const apiUrl = getApiUrl();
        if (!apiUrl) return { error: "EMAIL_API_URL not configured." };

        const url = new URL(`${apiUrl}/messages/${encodeURIComponent(params.messageId)}`);
        if (params.markRead) url.searchParams.set("markRead", "true");

        const res = await safeFetch(url.toString(), { ssrfProtection: false });
        if (!res.ok) return { error: `Email read returned ${res.status}` };

        const data = (await res.json()) as { id: string; from: string; to: string; subject: string; date: string; body: string; attachments?: Array<{ name: string; size: number }> };
        return {
          id: data.id,
          from: data.from,
          to: data.to,
          subject: data.subject,
          date: data.date,
          body: data.body?.slice(0, 5000),
          attachments: data.attachments ?? [],
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "email_reader",
      instructions: "You can read emails with `email_fetch_inbox` (list recent messages), `email_search` (find specific emails), and `email_read` (get full message content). Requires EMAIL_API_URL pointing to an email REST proxy.",
    };
  },
};

export default emailReaderSkill;
