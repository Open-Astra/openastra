// ── WhatsApp Channel (Cloud API) ────────────────────────────────────
// Connects to WhatsApp via the Meta Cloud API (formerly WhatsApp Business
// API). Receives messages through a webhook, sends replies via REST.
//
// Requirements:
//  • A Meta Business account with WhatsApp Business API access
//  • WHATSAPP_PHONE_NUMBER_ID — Phone number ID from Meta dashboard
//  • WHATSAPP_ACCESS_TOKEN — Permanent access token
//  • WHATSAPP_VERIFY_TOKEN — Webhook verification token (you choose this)
//  • GATEWAY_URL — Public URL for webhook registration
//
// Architecture:
//  • Webhook verification: GET /webhooks/whatsapp (Meta challenge)
//  • Receives messages: POST /webhooks/whatsapp
//  • Sends replies via Graph API v21.0

import type {
  ChannelAdapter,
  IncomingMessage,
  OutgoingMessage,
  ClientResolver,
} from "./base.js";
import { handleIncomingMessage } from "./base.js";
import { createLogger } from "../utils/logger.js";
import type { Express } from "express";

const log = createLogger("whatsapp");

// ── WhatsApp Cloud API Types ──────────────────────────────────────

interface WAWebhookPayload {
  object: string;
  entry?: Array<{
    id: string;
    changes: Array<{
      value: {
        messaging_product: string;
        metadata: { display_phone_number: string; phone_number_id: string };
        contacts?: Array<{ profile: { name: string }; wa_id: string }>;
        messages?: Array<WAMessage>;
        statuses?: Array<unknown>;
      };
      field: string;
    }>;
  }>;
}

interface WAMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: WAMedia;
  audio?: WAMedia;
  video?: WAMedia;
  document?: WAMedia & { filename?: string };
}

interface WAMedia {
  id: string;
  mime_type?: string;
  caption?: string;
}

// ── WhatsApp Adapter ───────────────────────────────────────────────

export class WhatsAppAdapter implements ChannelAdapter {
  readonly channelType = "whatsapp" as const;
  private phoneNumberId: string;
  private accessToken: string;
  private verifyToken: string;
  private resolveClient: ClientResolver;
  private app: Express | null;

  constructor(
    phoneNumberId: string,
    accessToken: string,
    verifyToken: string,
    resolveClient: ClientResolver,
    app?: Express,
  ) {
    this.phoneNumberId = phoneNumberId;
    this.accessToken = accessToken;
    this.verifyToken = verifyToken;
    this.resolveClient = resolveClient;
    this.app = app ?? null;
  }

  // ── Graph API Layer ──────────────────────────────────────────────

  private get apiBase(): string {
    return `https://graph.facebook.com/v21.0/${this.phoneNumberId}`;
  }

  private async graphApi<T>(
    endpoint: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const res = await fetch(`${this.apiBase}/${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`WhatsApp API ${endpoint}: ${res.status} ${text}`);
    }
    return (await res.json()) as T;
  }

  private async getMediaUrl(mediaId: string): Promise<string> {
    const res = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (!res.ok) return "";
    const data = (await res.json()) as { url?: string };
    return data.url ?? "";
  }

  // ── ChannelAdapter Interface ───────────────────────────────────

  async sendMessage(chatId: string, message: OutgoingMessage): Promise<void> {
    const chunks = splitText(message.text, 4096);
    for (const chunk of chunks) {
      await this.graphApi("messages", {
        messaging_product: "whatsapp",
        to: chatId,
        type: "text",
        text: { body: chunk },
      });
    }
  }

  async sendTypingIndicator(_chatId: string): Promise<void> {
    // WhatsApp Cloud API doesn't support typing indicators
  }

  async start(): Promise<void> {
    if (this.app) {
      // Webhook verification (GET)
      this.app.get("/webhooks/whatsapp", (req, res) => {
        const mode = req.query["hub.mode"] as string;
        const token = req.query["hub.verify_token"] as string;
        const challenge = req.query["hub.challenge"] as string;

        if (mode === "subscribe" && token === this.verifyToken) {
          log.info("Webhook verified by Meta");
          res.status(200).send(challenge);
        } else {
          log.warn("Webhook verification failed");
          res.sendStatus(403);
        }
      });

      // Message webhook (POST)
      this.app.post("/webhooks/whatsapp", (req, res) => {
        res.sendStatus(200); // Always acknowledge quickly
        const payload = req.body as WAWebhookPayload;
        this.handleWebhook(payload).catch((err) => {
          log.error("Webhook handler error:", err);
        });
      });
      log.info("Webhooks registered at /webhooks/whatsapp");
    }

    log.active("WhatsApp channel started", `Phone: ${this.phoneNumberId}`);
  }

  async stop(): Promise<void> {
    log.warn("WhatsApp channel stopped");
  }

  // ── Webhook Handler ──────────────────────────────────────────────

  private async handleWebhook(payload: WAWebhookPayload): Promise<void> {
    if (payload.object !== "whatsapp_business_account") return;

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes) {
        if (change.field !== "messages") continue;
        const value = change.value;
        const messages = value.messages ?? [];
        const contacts = value.contacts ?? [];

        for (const msg of messages) {
          const contact = contacts.find((c) => c.wa_id === msg.from);
          const senderName = contact?.profile?.name ?? msg.from;
          const text =
            msg.text?.body ??
            msg.image?.caption ??
            msg.audio?.caption ??
            msg.video?.caption ??
            msg.document?.caption;

          // Build attachments
          const attachments: IncomingMessage["attachments"] = [];
          if (msg.image) {
            attachments.push({
              type: "image",
              mimeType: msg.image.mime_type,
              url: await this.getMediaUrl(msg.image.id),
            });
          }
          if (msg.audio) {
            attachments.push({
              type: "audio",
              mimeType: msg.audio.mime_type,
              url: await this.getMediaUrl(msg.audio.id),
            });
          }
          if (msg.video) {
            attachments.push({
              type: "video",
              mimeType: msg.video.mime_type,
              url: await this.getMediaUrl(msg.video.id),
            });
          }
          if (msg.document) {
            attachments.push({
              type: "file",
              mimeType: msg.document.mime_type,
              filename: msg.document.filename,
              url: await this.getMediaUrl(msg.document.id),
            });
          }

          if (!text && attachments.length === 0) continue;

          const incoming: IncomingMessage = {
            channel: "whatsapp",
            chatId: msg.from,
            senderId: msg.from,
            senderName,
            text: text ?? undefined,
            isGroup: false, // WhatsApp Cloud API groups handled separately
            messageId: msg.id,
            attachments: attachments.length > 0 ? attachments : undefined,
          };

          handleIncomingMessage(incoming, this, this.resolveClient).catch(
            (err) => {
              log.error(`Error processing message from ${msg.from}:`, err);
            },
          );
        }
      }
    }
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

let _adapter: WhatsAppAdapter | null = null;

export function startWhatsAppChannel(
  phoneNumberId: string,
  accessToken: string,
  verifyToken: string,
  resolveClient: ClientResolver,
  app?: Express,
): void {
  _adapter = new WhatsAppAdapter(phoneNumberId, accessToken, verifyToken, resolveClient, app);
  _adapter.start();
}

export function stopWhatsAppChannel(): void {
  if (_adapter) {
    _adapter.stop();
    _adapter = null;
  }
}
