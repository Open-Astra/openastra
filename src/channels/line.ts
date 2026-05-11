// ── LINE Messaging API Channel ────────────────────────────────────
// Full-featured LINE bot using the Messaging API for receiving messages
// and the push API for sending responses.
//
// Requirements:
//  • LINE_CHANNEL_ACCESS_TOKEN — Channel access token for the LINE bot
//  • LINE_CHANNEL_SECRET — Channel secret for webhook signature verification
//
// Architecture:
//  • Webhook: POST /webhooks/line (message events)
//  • HMAC-SHA256 signature verification via x-line-signature header
//  • Push API for sending messages (max 5 per call, 5000 chars per message)
//  • Supports DMs and group/room conversations

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

const log = createLogger("line");

const LINE_API = "https://api.line.me/v2/bot";

// ── LINE Types ──────────────────────────────────────────────────────

interface LineWebhookPayload {
  events: LineEvent[];
}

interface LineEvent {
  type: string; // "message" | "follow" | "unfollow" | "join" | "leave"
  timestamp: number;
  replyToken?: string;
  source: {
    type: "user" | "group" | "room";
    userId?: string;
    groupId?: string;
    roomId?: string;
  };
  message?: {
    type: string; // "text" | "image" | "audio" | "video" | "file" | "sticker"
    id: string;
    text?: string;
    fileName?: string;
    contentProvider?: { type: string };
  };
}

interface LineProfileResponse {
  displayName: string;
}

// ── LINE Adapter ────────────────────────────────────────────────────

export class LineAdapter implements ChannelAdapter {
  readonly channelType = "line" as const;
  private channelAccessToken: string;
  private channelSecret: string;
  private resolveClient: ClientResolver;
  private app: Express | null;
  private userNameCache = new Map<string, string>();

  constructor(
    channelAccessToken: string,
    channelSecret: string,
    resolveClient: ClientResolver,
    app?: Express,
  ) {
    this.channelAccessToken = channelAccessToken;
    this.channelSecret = channelSecret;
    this.resolveClient = resolveClient;
    this.app = app ?? null;
  }

  // ── LINE API ──────────────────────────────────────────────────────

  private async lineApi<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const res = await fetch(`${LINE_API}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.channelAccessToken}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LINE API ${method} ${path}: ${res.status} ${text}`);
    }
    return (await res.json()) as T;
  }

  private async getUserName(userId: string, groupId?: string): Promise<string> {
    const cacheKey = groupId ? `${groupId}:${userId}` : userId;
    if (this.userNameCache.has(cacheKey)) return this.userNameCache.get(cacheKey)!;
    try {
      let profile: LineProfileResponse;
      if (groupId) {
        profile = await this.lineApi<LineProfileResponse>(
          "GET",
          `/group/${groupId}/member/${userId}`,
        );
      } else {
        profile = await this.lineApi<LineProfileResponse>(
          "GET",
          `/profile/${userId}`,
        );
      }
      const name = profile.displayName;
      this.userNameCache.set(cacheKey, name);
      return name;
    } catch {
      return userId;
    }
  }

  // ── Request Verification ──────────────────────────────────────────

  private verifyRequest(req: Request): boolean {
    const signature = req.headers["x-line-signature"] as string | undefined;
    if (!signature) return false;

    const expected = createHmac("sha256", this.channelSecret)
      .update(JSON.stringify(req.body))
      .digest("base64");

    try {
      return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  // ── ChannelAdapter Interface ──────────────────────────────────────

  async sendMessage(chatId: string, message: OutgoingMessage): Promise<void> {
    const chunks = splitText(message.text, 5000);
    // LINE allows max 5 messages per push call
    for (let i = 0; i < chunks.length; i += 5) {
      const batch = chunks.slice(i, i + 5);
      await this.lineApi("POST", "/message/push", {
        to: chatId,
        messages: batch.map((chunk) => ({ type: "text", text: chunk })),
      });
    }
  }

  async sendTypingIndicator(_chatId: string): Promise<void> {
    // LINE has no public typing indicator API — no-op
  }

  async start(): Promise<void> {
    if (this.app) {
      this.app.post("/webhooks/line", (req, res) => {
        // Verify request signature
        if (!this.verifyRequest(req)) {
          log.warn("Invalid request signature");
          res.sendStatus(403);
          return;
        }

        res.sendStatus(200); // Acknowledge quickly

        const payload = req.body as LineWebhookPayload;
        for (const event of payload.events ?? []) {
          this.handleEvent(event).catch((err) => {
            log.error("Event handler error:", err);
          });
        }
      });
      log.info("Webhook registered at POST /webhooks/line");
    }

    log.active("LINE channel started");
  }

  async stop(): Promise<void> {
    log.warn("LINE channel stopped");
  }

  // ── Event Handler ─────────────────────────────────────────────────

  private async handleEvent(event: LineEvent): Promise<void> {
    // Only handle message events
    if (event.type !== "message") return;
    if (!event.message) return;

    const msg = event.message;

    // Only handle text and media attachments
    const isText = msg.type === "text";
    const isMedia =
      msg.type === "image" ||
      msg.type === "audio" ||
      msg.type === "video" ||
      msg.type === "file";

    if (!isText && !isMedia) return;
    if (isText && !msg.text?.trim()) return;

    const source = event.source;
    const chatId =
      source.groupId ?? source.roomId ?? source.userId;
    if (!chatId) return;

    const senderId = source.userId ?? "unknown";
    const isGroup =
      source.type === "group" || source.type === "room";

    const senderName = await this.getUserName(
      senderId,
      source.groupId,
    );

    // Build attachments for media messages
    const attachments: IncomingMessage["attachments"] = [];
    if (isMedia) {
      const attachType =
        msg.type === "image"
          ? ("image" as const)
          : msg.type === "audio"
            ? ("audio" as const)
            : msg.type === "video"
              ? ("video" as const)
              : ("file" as const);
      attachments.push({
        type: attachType,
        filename: msg.fileName,
      });
    }

    const incoming: IncomingMessage = {
      channel: "line",
      chatId,
      senderId,
      senderName,
      text: msg.text ?? undefined,
      isGroup,
      messageId: msg.id,
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    await handleIncomingMessage(incoming, this, this.resolveClient);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

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

// ── Lifecycle Exports ─────────────────────────────────────────────────

let _adapter: LineAdapter | null = null;

export function startLineChannel(
  token: string,
  secret: string,
  resolveClient: ClientResolver,
  app?: Express,
): void {
  _adapter = new LineAdapter(token, secret, resolveClient, app);
  _adapter.start();
}

export function stopLineChannel(): void {
  if (_adapter) {
    _adapter.stop();
    _adapter = null;
  }
}
