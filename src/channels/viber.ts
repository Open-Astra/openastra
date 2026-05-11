// ── Viber Channel (Viber Bot API) ────────────────────────────────────
// Viber bot adapter using the Viber REST API for receiving and sending
// messages. Viber bots operate in 1:1 mode only via the public bot API.
//
// Requirements:
//  • VIBER_AUTH_TOKEN — Auth token from the Viber bot dashboard
//  • VIBER_BOT_NAME   — Display name for the bot in outgoing messages
//
// Architecture:
//  • Webhook: POST /webhooks/viber
//  • Signature verification via HMAC-SHA256 (x-viber-content-signature)
//  • Sends text messages via POST https://chatapi.viber.com/pa/send_message
//  • Webhook must be registered manually — see startup log for instructions

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

const log = createLogger("viber");

const VIBER_API = "https://chatapi.viber.com/pa";

// ── Viber Types ─────────────────────────────────────────────────────

interface ViberEvent {
  event: string; // "message" | "conversation_started" | "subscribed" | "unsubscribed" | "seen" | "delivered" | "failed"
  timestamp: number;
  messageToken?: number;
  chatId?: string; // group chat ID (only for group chats)
  sender?: {
    id: string;
    name: string;
    avatar?: string;
    country?: string;
    language?: string;
  };
  message?: {
    type: string; // "text" | "picture" | "video" | "file" | "sticker" | "url" | "location" | "contact"
    text?: string;
    media?: string; // URL for media
    fileName?: string;
    size?: number;
    duration?: number;
  };
}

interface ViberApiResponse {
  status: number;
  status_message: string;
}

// ── Viber Adapter ───────────────────────────────────────────────────

export class ViberAdapter implements ChannelAdapter {
  readonly channelType = "viber" as const;
  private authToken: string;
  private botName: string;
  private resolveClient: ClientResolver;
  private app: Express | null;

  constructor(
    authToken: string,
    botName: string,
    resolveClient: ClientResolver,
    app?: Express,
  ) {
    this.authToken = authToken;
    this.botName = botName;
    this.resolveClient = resolveClient;
    this.app = app ?? null;
  }

  // ── Viber API ────────────────────────────────────────────────────

  private async viberApi<T>(
    endpoint: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const res = await fetch(`${VIBER_API}/${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Viber-Auth-Token": this.authToken,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Viber API ${endpoint}: ${res.status} ${text}`);
    }
    return (await res.json()) as T;
  }

  // ── Request Verification ─────────────────────────────────────────

  private verifyRequest(req: Request): boolean {
    const signature = req.headers["x-viber-content-signature"] as string | undefined;
    if (!signature) return false;

    const expected = createHmac("sha256", this.authToken)
      .update(JSON.stringify(req.body))
      .digest("hex");

    try {
      return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  // ── ChannelAdapter Interface ──────────────────────────────────────

  async sendMessage(chatId: string, message: OutgoingMessage): Promise<void> {
    const chunks = splitText(message.text, 7000);
    for (const chunk of chunks) {
      await this.viberApi<ViberApiResponse>("send_message", {
        receiver: chatId,
        type: "text",
        text: chunk,
        sender: { name: this.botName },
      });
    }
  }

  async sendTypingIndicator(_chatId: string): Promise<void> {
    // Viber has no public typing indicator API for bots
  }

  async start(): Promise<void> {
    if (this.app) {
      this.app.post("/webhooks/viber", (req, res) => {
        // Verify request signature
        if (!this.verifyRequest(req)) {
          log.warn("Invalid request signature");
          res.sendStatus(403);
          return;
        }

        res.sendStatus(200); // Acknowledge quickly

        const event = req.body as ViberEvent;

        if (event.event === "message" && event.sender) {
          this.handleEvent(event).catch((err) => {
            log.error("Event handler error:", err);
          });
        }
      });
      log.info("Webhook registered at POST /webhooks/viber");
    }

    log.dim(
      "Viber webhook must be registered manually. " +
        "Call POST https://chatapi.viber.com/pa/set_webhook with your external URL " +
        "(e.g. https://<your-domain>/webhooks/viber) and X-Viber-Auth-Token header. " +
        "Set GATEWAY_URL in your environment to construct the full URL.",
    );

    log.active("Viber channel started");
  }

  async stop(): Promise<void> {
    log.warn("Viber channel stopped");
  }

  // ── Event Handler ────────────────────────────────────────────────

  private async handleEvent(event: ViberEvent): Promise<void> {
    if (event.event !== "message") return;

    const sender = event.sender;
    if (!sender) return;

    const text = event.message?.text ?? "";
    const msgType = event.message?.type ?? "text";

    // Build attachments for non-text message types
    const attachments: IncomingMessage["attachments"] = [];
    if (event.message && msgType !== "text" && event.message.media) {
      const type =
        msgType === "picture"
          ? ("image" as const)
          : msgType === "video"
            ? ("video" as const)
            : msgType === "file"
              ? ("file" as const)
              : ("file" as const);
      attachments.push({
        type,
        url: event.message.media,
        filename: event.message.fileName,
      });
    }

    if (!text && attachments.length === 0) return;

    const incoming: IncomingMessage = {
      channel: "viber",
      chatId: sender.id,
      senderId: sender.id,
      senderName: sender.name,
      text: text || undefined,
      isGroup: false,
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    await handleIncomingMessage(incoming, this, this.resolveClient);
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

let _adapter: ViberAdapter | null = null;

export function startViberChannel(
  authToken: string,
  botName: string,
  resolveClient: ClientResolver,
  app?: Express,
): void {
  _adapter = new ViberAdapter(authToken, botName, resolveClient, app);
  _adapter.start();
}

export function stopViberChannel(): void {
  if (_adapter) {
    _adapter.stop();
    _adapter = null;
  }
}
