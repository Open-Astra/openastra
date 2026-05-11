// ── X/Twitter Direct Messages Channel (Account Activity API) ────────
// Receives DMs via the Account Activity API webhook and sends replies
// using the v2 DM API with OAuth 1.0a signing.
//
// Requirements:
//  • X_API_KEY — Consumer key
//  • X_API_SECRET — Consumer secret
//  • X_ACCESS_TOKEN — User access token
//  • X_ACCESS_TOKEN_SECRET — User access token secret
//  • X_BEARER_TOKEN — Bearer token (for read operations / bot ID fetch)
//  • X_WEBHOOK_ENV — Account Activity API environment name (e.g. "dev")
//
// Architecture:
//  • GET  /webhooks/twitter — CRC challenge response
//  • POST /webhooks/twitter — incoming Account Activity events

import type {
  ChannelAdapter,
  IncomingMessage,
  OutgoingMessage,
  ClientResolver,
} from "./base.js";
import { handleIncomingMessage } from "./base.js";
import { createLogger } from "../utils/logger.js";
import type { Express, Request, Response } from "express";
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

const log = createLogger("twitter");

const TWITTER_API_V2 = "https://api.twitter.com/2";
const TWITTER_API_V1 = "https://api.twitter.com/1.1";

// ── Twitter Types ───────────────────────────────────────────────────

interface TwitterWebhookPayload {
  for_user_id?: string;
  direct_message_events?: Array<{
    type: string; // "message_create"
    id: string;
    created_timestamp: string;
    message_create: {
      sender_id: string;
      target: { recipient_id: string };
      message_data: {
        text: string;
        attachment?: {
          type: string;
          media?: {
            type: string; // "photo" | "video" | "animated_gif"
            media_url_https: string;
          };
        };
      };
    };
  }>;
  users?: Record<string, { name: string; screen_name: string }>;
}

interface TwitterMeResponse {
  data: { id: string; name: string };
}

// ── Twitter Adapter ─────────────────────────────────────────────────

export class TwitterAdapter implements ChannelAdapter {
  readonly channelType = "twitter" as const;
  private apiKey: string;
  private apiSecret: string;
  private accessToken: string;
  private accessTokenSecret: string;
  private bearerToken: string;
  private webhookEnv: string;
  private resolveClient: ClientResolver;
  private app: Express | null;
  private botUserId: string | null = null;

  constructor(
    apiKey: string,
    apiSecret: string,
    accessToken: string,
    accessTokenSecret: string,
    bearerToken: string,
    webhookEnv: string,
    resolveClient: ClientResolver,
    app?: Express,
  ) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.accessToken = accessToken;
    this.accessTokenSecret = accessTokenSecret;
    this.bearerToken = bearerToken;
    this.webhookEnv = webhookEnv;
    this.resolveClient = resolveClient;
    this.app = app ?? null;
  }

  // ── OAuth 1.0a Signing ──────────────────────────────────────────

  private buildOAuthHeader(
    method: string,
    url: string,
    extraParams: Record<string, string> = {},
  ): string {
    const oauthParams: Record<string, string> = {
      oauth_consumer_key: this.apiKey,
      oauth_nonce: randomBytes(16).toString("hex"),
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: String(Math.floor(Date.now() / 1000)),
      oauth_token: this.accessToken,
      oauth_version: "1.0",
      ...extraParams,
    };

    // Signature base string
    const allParams = { ...oauthParams };
    const paramString = Object.keys(allParams)
      .sort()
      .map(
        (k) =>
          `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k]!)}`,
      )
      .join("&");
    const baseString = [
      method.toUpperCase(),
      encodeURIComponent(url),
      encodeURIComponent(paramString),
    ].join("&");
    const signingKey = `${encodeURIComponent(this.apiSecret)}&${encodeURIComponent(this.accessTokenSecret)}`;
    const signature = createHmac("sha1", signingKey)
      .update(baseString)
      .digest("base64");

    // Build header
    const headerParams: Record<string, string> = { ...oauthParams, oauth_signature: signature };
    const headerStr = Object.keys(headerParams)
      .map(
        (k) =>
          `${encodeURIComponent(k)}="${encodeURIComponent(headerParams[k]!)}"`,
      )
      .join(", ");
    return `OAuth ${headerStr}`;
  }

  // ── CRC Challenge Verification ──────────────────────────────────

  private buildCrcResponse(crcToken: string): string {
    const hmac = createHmac("sha256", this.apiSecret)
      .update(crcToken)
      .digest("base64");
    return `sha256=${hmac}`;
  }

  private verifyWebhookSignature(req: Request): boolean {
    const signature = req.headers["x-twitter-webhooks-signature"] as
      | string
      | undefined;
    if (!signature) return false;

    const rawBody = JSON.stringify(req.body);
    const expected = `sha256=${createHmac("sha256", this.apiSecret).update(rawBody).digest("base64")}`;

    try {
      return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  // ── ChannelAdapter Interface ────────────────────────────────────

  async sendMessage(chatId: string, message: OutgoingMessage): Promise<void> {
    const chunks = splitText(message.text, 10000);
    const url = `${TWITTER_API_V2}/dm_conversations/with/${chatId}/messages`;
    for (const chunk of chunks) {
      const oauthHeader = this.buildOAuthHeader("POST", url);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: oauthHeader,
        },
        body: JSON.stringify({ text: chunk }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Twitter DM send failed: ${res.status} ${text}`);
      }
    }
  }

  async sendTypingIndicator(_chatId: string): Promise<void> {
    // No public DM typing API available for X/Twitter
  }

  async start(): Promise<void> {
    // Fetch bot user ID via Bearer token
    try {
      const res = await fetch(`${TWITTER_API_V2}/users/me`, {
        headers: { Authorization: `Bearer ${this.bearerToken}` },
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`${res.status} ${text}`);
      }
      const data = (await res.json()) as TwitterMeResponse;
      this.botUserId = data.data.id;
      log.active("Bot authenticated", `User ID: ${this.botUserId}`);
    } catch (err) {
      log.error("Failed to fetch bot user ID:", err);
    }

    if (this.app) {
      // CRC challenge endpoint
      this.app.get("/webhooks/twitter", (req: Request, res: Response) => {
        const crcToken = req.query["crc_token"];
        if (typeof crcToken !== "string" || !crcToken) {
          res.sendStatus(400);
          return;
        }
        res.status(200).json({
          response_token: this.buildCrcResponse(crcToken),
        });
      });

      // Incoming events endpoint
      this.app.post("/webhooks/twitter", (req: Request, res: Response) => {
        if (!this.verifyWebhookSignature(req)) {
          log.warn("Invalid webhook signature");
          res.sendStatus(403);
          return;
        }

        res.sendStatus(200); // Acknowledge quickly

        const payload = req.body as TwitterWebhookPayload;
        this.handlePayload(payload).catch((err) => {
          log.error("Payload handler error:", err);
        });
      });

      log.info("Webhook registered at GET /webhooks/twitter (CRC)");
      log.info("Webhook registered at POST /webhooks/twitter (events)");
    }

    log.active("X/Twitter DMs channel started");
    log.dim(
      `To receive events, register your webhook URL via: POST ${TWITTER_API_V1}/account_activity/all/${this.webhookEnv}/webhooks.json with your external HTTPS URL if not already done.`,
    );
  }

  async stop(): Promise<void> {
    log.warn("X/Twitter DMs channel stopped");
  }

  // ── Event Handler ───────────────────────────────────────────────

  private async handlePayload(payload: TwitterWebhookPayload): Promise<void> {
    if (!payload.direct_message_events?.length) return;

    for (const event of payload.direct_message_events) {
      if (event.type !== "message_create") continue;

      const senderId = event.message_create.sender_id;

      // Ignore messages sent by the bot itself
      if (this.botUserId && senderId === this.botUserId) continue;

      const text = event.message_create.message_data.text;
      const senderName = payload.users?.[senderId]?.name ?? senderId;

      // Build attachments
      const attachments: IncomingMessage["attachments"] = [];
      const attachment = event.message_create.message_data.attachment;
      if (attachment?.media) {
        const mediaType = attachment.media.type;
        const type =
          mediaType === "photo"
            ? ("image" as const)
            : mediaType === "video"
              ? ("video" as const)
              : mediaType === "animated_gif"
                ? ("video" as const)
                : ("file" as const);
        attachments.push({
          type,
          url: attachment.media.media_url_https,
        });
      }

      const incoming: IncomingMessage = {
        channel: "twitter",
        chatId: senderId,
        senderId,
        senderName,
        text: text || undefined,
        isGroup: false,
        messageId: event.id,
        attachments: attachments.length > 0 ? attachments : undefined,
      };

      await handleIncomingMessage(incoming, this, this.resolveClient);
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

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

// ── Lifecycle Exports ────────────────────────────────────────────────

let _adapter: TwitterAdapter | null = null;

export function startTwitterChannel(
  apiKey: string,
  apiSecret: string,
  accessToken: string,
  accessTokenSecret: string,
  bearerToken: string,
  webhookEnv: string,
  resolveClient: ClientResolver,
  app?: Express,
): void {
  _adapter = new TwitterAdapter(
    apiKey,
    apiSecret,
    accessToken,
    accessTokenSecret,
    bearerToken,
    webhookEnv,
    resolveClient,
    app,
  );
  _adapter.start();
}

export function stopTwitterChannel(): void {
  if (_adapter) {
    _adapter.stop();
    _adapter = null;
  }
}
