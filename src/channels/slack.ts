// ── Slack Channel (Events API + Web API) ────────────────────────────
// Full-featured Slack bot using the Events API for receiving messages
// and the Web API for sending responses.
//
// Requirements:
//  • SLACK_BOT_TOKEN — Bot User OAuth Token (xoxb-...)
//  • SLACK_SIGNING_SECRET — Signing secret for webhook verification
//  • SLACK_APP_TOKEN — App-level token for Socket Mode (optional, xapp-...)
//
// Architecture:
//  • Events API: POST /webhooks/slack (message events)
//  • URL verification challenge handling
//  • Web API for sending messages, typing indicators
//  • Supports DMs, channels (when @mentioned), threads

import type {
  ChannelAdapter,
  IncomingMessage,
  OutgoingMessage,
  ClientResolver,
} from "./base.js";
import { handleIncomingMessage } from "./base.js";
import { createLogger } from "../utils/logger.js";
import type { Express, Request } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";

const log = createLogger("slack");

const SLACK_API = "https://slack.com/api";

// ── Slack Types ────────────────────────────────────────────────────

interface SlackEventPayload {
  type: string;
  token?: string;
  challenge?: string;
  team_id?: string;
  event?: SlackMessageEvent;
  event_id?: string;
  event_time?: number;
}

interface SlackMessageEvent {
  type: string;
  subtype?: string;
  channel: string;
  channel_type?: string; // "im" for DMs, "channel" / "group" for channels
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
  files?: Array<{
    id: string;
    name: string;
    mimetype: string;
    url_private: string;
  }>;
}

interface SlackUserInfo {
  ok: boolean;
  user?: { real_name?: string; name: string };
}

// ── Slack Adapter ──────────────────────────────────────────────────

export class SlackAdapter implements ChannelAdapter {
  readonly channelType = "slack" as const;
  private botToken: string;
  private signingSecret: string;
  private resolveClient: ClientResolver;
  private app: Express | null;
  private botUserId: string | null = null;
  private userNameCache = new Map<string, string>();

  constructor(
    botToken: string,
    signingSecret: string,
    resolveClient: ClientResolver,
    app?: Express,
  ) {
    this.botToken = botToken;
    this.signingSecret = signingSecret;
    this.resolveClient = resolveClient;
    this.app = app ?? null;
  }

  // ── Slack Web API ────────────────────────────────────────────────

  private async slackApi<T>(
    method: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const res = await fetch(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${this.botToken}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Slack API ${method}: ${res.status} ${text}`);
    }
    return (await res.json()) as T;
  }

  private async getUserName(userId: string): Promise<string> {
    if (this.userNameCache.has(userId)) return this.userNameCache.get(userId)!;
    try {
      const info = await this.slackApi<SlackUserInfo>("users.info", {
        user: userId,
      });
      const name = info.user?.real_name ?? info.user?.name ?? userId;
      this.userNameCache.set(userId, name);
      return name;
    } catch {
      return userId;
    }
  }

  // ── Request Verification ─────────────────────────────────────────

  private verifyRequest(req: Request): boolean {
    const timestamp = req.headers["x-slack-request-timestamp"] as string;
    const signature = req.headers["x-slack-signature"] as string;
    if (!timestamp || !signature) return false;

    // Prevent replay attacks (5 minute window)
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(timestamp, 10)) > 300) return false;

    const rawBody = JSON.stringify(req.body);
    const baseString = `v0:${timestamp}:${rawBody}`;
    const expected = `v0=${createHmac("sha256", this.signingSecret).update(baseString).digest("hex")}`;

    try {
      return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  // ── ChannelAdapter Interface ───────────────────────────────────

  async sendMessage(chatId: string, message: OutgoingMessage): Promise<void> {
    const chunks = splitText(message.text, 4000);
    for (const chunk of chunks) {
      await this.slackApi("chat.postMessage", {
        channel: chatId,
        text: chunk,
        ...(message.replyTo ? { thread_ts: message.replyTo } : {}),
      });
    }
  }

  async sendTypingIndicator(_chatId: string): Promise<void> {
    // Slack doesn't have a public typing indicator API for bots
  }

  async start(): Promise<void> {
    // Get bot user ID for @mention detection
    try {
      const auth = await this.slackApi<{ ok: boolean; user_id?: string }>("auth.test");
      this.botUserId = auth.user_id ?? null;
      log.active("Bot authenticated", `User ID: ${this.botUserId}`);
    } catch (err) {
      log.error("Failed to authenticate:", err);
    }

    if (this.app) {
      this.app.post("/webhooks/slack", (req, res) => {
        const payload = req.body as SlackEventPayload;

        // URL verification challenge
        if (payload.type === "url_verification") {
          res.status(200).json({ challenge: payload.challenge });
          return;
        }

        // Verify request signature
        if (!this.verifyRequest(req)) {
          log.warn("Invalid request signature");
          res.sendStatus(403);
          return;
        }

        res.sendStatus(200); // Acknowledge quickly

        if (payload.type === "event_callback" && payload.event) {
          this.handleEvent(payload.event).catch((err) => {
            log.error("Event handler error:", err);
          });
        }
      });
      log.info("Webhook registered at POST /webhooks/slack");
    }

    log.active("Slack channel started");
  }

  async stop(): Promise<void> {
    log.warn("Slack channel stopped");
  }

  // ── Event Handler ────────────────────────────────────────────────

  private async handleEvent(event: SlackMessageEvent): Promise<void> {
    // Only handle message events (not subtypes like edits, deletes, etc.)
    if (event.type !== "message" || event.subtype) return;

    // Ignore bot messages
    if (event.bot_id) return;

    const userId = event.user;
    if (!userId) return;

    const text = event.text ?? "";
    const isDM = event.channel_type === "im";

    // In channels, only respond when @mentioned
    if (!isDM) {
      if (!this.botUserId || !text.includes(`<@${this.botUserId}>`)) return;
    }

    // Strip bot mention from text
    let cleanText = text;
    if (this.botUserId) {
      cleanText = cleanText.replace(new RegExp(`<@${this.botUserId}>`, "g"), "").trim();
    }

    if (!cleanText && !event.files?.length) return;

    const senderName = await this.getUserName(userId);

    // Build attachments
    const attachments: IncomingMessage["attachments"] = [];
    if (event.files?.length) {
      for (const file of event.files) {
        const type = file.mimetype.startsWith("image/")
          ? ("image" as const)
          : file.mimetype.startsWith("audio/")
            ? ("audio" as const)
            : file.mimetype.startsWith("video/")
              ? ("video" as const)
              : ("file" as const);
        attachments.push({
          type,
          mimeType: file.mimetype,
          filename: file.name,
          url: file.url_private,
        });
      }
    }

    const incoming: IncomingMessage = {
      channel: "slack",
      chatId: event.channel,
      senderId: userId,
      senderName,
      text: cleanText || undefined,
      isGroup: !isDM,
      messageId: event.thread_ts ?? event.ts,
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    await handleIncomingMessage(incoming, this, this.resolveClient);
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(" ", maxLen);
    if (splitAt <= 0) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

// ── Lifecycle Exports ──────────────────────────────────────────────

let _adapter: SlackAdapter | null = null;

export function startSlackBot(
  botToken: string,
  signingSecret: string,
  resolveClient: ClientResolver,
  app?: Express,
): void {
  _adapter = new SlackAdapter(botToken, signingSecret, resolveClient, app);
  _adapter.start();
}

export function stopSlackBot(): void {
  if (_adapter) {
    _adapter.stop();
    _adapter = null;
  }
}
