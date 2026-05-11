// ── Gmail Read Tool ───────────────────────────────────────────────────
// Read unread emails and fetch message details.
// Respects workspace whitelist for sender verification.

import { z } from "zod";
import { registerTool } from "./registry.js";
import { getGmailClient, getUnreadMessages, getMessage } from "./gmail-client.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("gmail-read");

const Params = z.object({
  maxResults: z.number().optional().default(10).describe("Max emails to fetch (default 10)"),
  includeBody: z
    .boolean()
    .optional()
    .default(true)
    .describe("Include full message body (default true)"),
});

registerTool({
  name: "gmail-read",
  description: "Read unread Gmail messages. Only returns emails from whitelisted senders.",
  parameters: Params,
  execute: async (params, ctx) => {
    if (!ctx.workspaceId) {
      return { success: false, error: "Workspace context required" };
    }

    try {
      // Fetch Gmail credentials from env var
      const credentials = process.env.GMAIL_CREDENTIALS_JSON;
      if (!credentials) {
        return { success: false, error: "Gmail not configured. Set GMAIL_CREDENTIALS_JSON env var." };
      }

      // Fetch whitelist from env var (comma-separated emails)
      const whitelistStr = process.env.GMAIL_WHITELIST || "";
      const whitelist = new Set(
        whitelistStr.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
      );

      if (whitelist.size === 0) {
        return { success: false, error: "No whitelisted senders configured" };
      }

      // Get Gmail client and fetch unread messages
      const gmail = getGmailClient(credentials);
      const messageIds = await getUnreadMessages(gmail, params.maxResults);

      const messages: any[] = [];
      for (const id of messageIds) {
        try {
          const msg = await getMessage(gmail, id);
          const senderEmail = extractEmail(msg.headers.from || "");

          // Only return whitelisted senders
          if (whitelist.has(senderEmail.toLowerCase())) {
            messages.push({
              id,
              from: msg.headers.from,
              subject: msg.headers.subject,
              date: msg.headers.date,
              body: params.includeBody ? msg.body : undefined,
              snippet: msg.snippet,
            });
          }
        } catch (err) {
          logger.error(`Failed to fetch message ${id}:`, err);
        }
      }

      logger.info(`Gmail read: fetched ${messages.length} messages from ${whitelist.size} whitelisted senders`);

      return {
        success: true,
        count: messages.length,
        whitelist: Array.from(whitelist),
        messages,
      };
    } catch (err) {
      logger.error("Gmail read failed:", err);
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

function extractEmail(header: string): string {
  const match = /<(.+?)>/.exec(header);
  return match ? match[1] : header.trim();
}
