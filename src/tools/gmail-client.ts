// ── Gmail API Client ──────────────────────────────────────────────────
// Wrapper around Gmail API for reading and sending emails.

import { google, type gmail_v1 } from "googleapis";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("gmail-client");

export interface GmailMessage {
  id: string;
  threadId: string;
  headers: Record<string, string>;
  body: string;
  snippet: string;
}

export function getGmailClient(credentialsJson: string): gmail_v1.Gmail {
  try {
    const credentials = JSON.parse(credentialsJson);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    });
    return google.gmail({ version: "v1", auth });
  } catch (err) {
    logger.error("Failed to initialize Gmail client:", err);
    throw new Error("Invalid Gmail credentials");
  }
}

export async function getUnreadMessages(
  gmail: gmail_v1.Gmail,
  maxResults: number = 10,
): Promise<string[]> {
  try {
    const response = await gmail.users.messages.list({
      userId: "me",
      q: "is:unread",
      maxResults,
    });
    return response.data.messages?.map((m) => m.id!).filter(Boolean) || [];
  } catch (err) {
    logger.error("Failed to fetch unread messages:", err);
    throw err;
  }
}

export async function getMessage(gmail: gmail_v1.Gmail, messageId: string): Promise<GmailMessage> {
  try {
    const response = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });

    const message = response.data;
    const headers: Record<string, string> = {};
    message.payload?.headers?.forEach((h) => {
      if (h.name && h.value) {
        headers[h.name.toLowerCase()] = h.value;
      }
    });

    let body = "";
    if (message.payload?.parts) {
      // Multipart message — extract text part
      const textPart = message.payload.parts.find((p) => p.mimeType === "text/plain");
      if (textPart?.body?.data) {
        body = Buffer.from(textPart.body.data, "base64").toString("utf-8");
      }
    } else if (message.payload?.body?.data) {
      // Simple message body
      body = Buffer.from(message.payload.body.data, "base64").toString("utf-8");
    }

    return {
      id: messageId,
      threadId: message.threadId || "",
      headers,
      body: body.trim(),
      snippet: message.snippet || "",
    };
  } catch (err) {
    logger.error(`Failed to fetch message ${messageId}:`, err);
    throw err;
  }
}

export async function sendReply(
  gmail: gmail_v1.Gmail,
  messageId: string,
  toEmail: string,
  subject: string,
  body: string,
): Promise<string> {
  try {
    const prefix = subject.startsWith("Re:") ? subject : `Re: ${subject}`;

    const rawEmail = [
      `To: ${toEmail}`,
      `Subject: ${prefix}`,
      `In-Reply-To: <${messageId}@gmail.com>`,
      "",
      body,
    ].join("\r\n");

    const encodedEmail = Buffer.from(rawEmail).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");

    const response = await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw: encodedEmail,
        threadId: messageId,
      },
    });

    return response.data.id || "";
  } catch (err) {
    logger.error(`Failed to send reply to ${toEmail}:`, err);
    throw err;
  }
}

export async function markAsRead(gmail: gmail_v1.Gmail, messageId: string): Promise<void> {
  try {
    await gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: {
        removeLabelIds: ["UNREAD"],
      },
    });
  } catch (err) {
    logger.error(`Failed to mark message ${messageId} as read:`, err);
  }
}
