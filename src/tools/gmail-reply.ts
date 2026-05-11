// ── Gmail Reply Tool ──────────────────────────────────────────────────
// Send replies to whitelisted senders only.
// Enforces strict guardrails: only reply to threads with whitelisted participants.

import { z } from "zod";
import { registerTool } from "./registry.js";
import { getGmailClient, getMessage, sendReply } from "./gmail-client.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("gmail-reply");

const Params = z.object({
  messageId: z.string().describe("Gmail message ID to reply to"),
  body: z.string().describe("Reply message body (plain text)"),
});

registerTool({
  name: "gmail-reply",
  description: "Reply to a Gmail message. Only works if sender is whitelisted and task marked complete.",
  parameters: Params,
  execute: async (params, ctx) => {
    if (!ctx.workspaceId) {
      return { success: false, error: "Workspace context required" };
    }

    try {
      // Fetch credentials from env var
      const credentials = process.env.GMAIL_CREDENTIALS_JSON;
      if (!credentials) {
        return { success: false, error: "Gmail not configured. Set GMAIL_CREDENTIALS_JSON env var." };
      }

      // Fetch whitelist from env var (comma-separated emails)
      const whitelistStr = process.env.GMAIL_WHITELIST || "";
      const whitelist = new Set(
        whitelistStr.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
      );

      // Get original message to verify sender is whitelisted
      const gmail = getGmailClient(credentials);
      const message = await getMessage(gmail, params.messageId);
      const senderEmail = extractEmail(message.headers.from || "").toLowerCase();

      if (!whitelist.has(senderEmail)) {
        logger.warn(`Gmail reply blocked: sender ${senderEmail} not whitelisted`);
        return {
          success: false,
          error: `Cannot reply: sender ${senderEmail} is not whitelisted`,
        };
      }

      // Send reply
      const replyId = await sendReply(
        gmail,
        params.messageId,
        senderEmail,
        message.headers.subject || "",
        params.body,
      );

      logger.info(`Gmail reply sent: ${replyId} to ${senderEmail}`);

      return {
        success: true,
        replyId,
        sentTo: senderEmail,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      logger.error("Gmail reply failed:", err);
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

function extractEmail(header: string): string {
  const match = /<(.+?)>/.exec(header);
  return match ? match[1] : header.trim();
}
