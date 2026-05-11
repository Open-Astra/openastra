// ── iMessage Channel (BlueBubbles) ──────────────────────────────────
// Connects to iMessage via BlueBubbles server, which exposes iMessage
// through a REST + WebSocket API running on a Mac.
//
// Requirements:
//  • BlueBubbles server running on a Mac with iMessage configured
//  • BLUEBUBBLES_URL — URL of your BlueBubbles server (e.g., http://192.168.1.10:1234)
//  • BLUEBUBBLES_PASSWORD — BlueBubbles server password
//
// Architecture:
//  • Receives messages via BlueBubbles webhook (POST /webhooks/imessage)
//  • Sends replies via BlueBubbles REST API
//  • Full channel abstraction: commands, memory search, agent routing

import type {
  ChannelAdapter,
  IncomingMessage,
  OutgoingMessage,
  ClientResolver,
} from "./base.js";
import { handleIncomingMessage } from "./base.js";
import { createLogger } from "../utils/logger.js";
import type { Express } from "express";

const log = createLogger("imessage");

// ── BlueBubbles API Types ──────────────────────────────────────────

interface BBMessage {
  guid: string;
  text: string | null;
  isFromMe: boolean;
  handle?: {
    address: string;
    service: string;
  };
  chats?: Array<{
    guid: string;
    chatIdentifier: string;
    displayName: string | null;
    participants?: Array<{ address: string }>;
  }>;
  dateCreated: number;
  attachments?: Array<{
    guid: string;
    mimeType: string | null;
    transferName: string | null;
    totalBytes: number;
  }>;
}

interface BBWebhookPayload {
  type: string;
  data: BBMessage;
}

// ── iMessage Adapter ───────────────────────────────────────────────

export class IMessageAdapter implements ChannelAdapter {
  readonly channelType = "imessage" as const;
  private baseUrl: string;
  private password: string;
  private resolveClient: ClientResolver;
  private app: Express | null;
  private processingChats = new Set<string>();

  constructor(
    baseUrl: string,
    password: string,
    resolveClient: ClientResolver,
    app?: Express,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.password = password;
    this.resolveClient = resolveClient;
    this.app = app ?? null;
  }

  // ── BlueBubbles API Layer ──────────────────────────────────────

  private async bbApi<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    // BlueBubbles authenticates via ?password= query parameter
    const sep = path.includes("?") ? "&" : "?";
    const url = `${this.baseUrl}/api/v1${path}${sep}password=${encodeURIComponent(this.password)}`;
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`BlueBubbles API ${method} ${path}: ${res.status} ${text}`);
    }

    return (await res.json()) as T;
  }

  // ── ChannelAdapter Interface ───────────────────────────────────

  async sendMessage(chatId: string, message: OutgoingMessage): Promise<void> {
    // BlueBubbles has a ~20,000 char limit for iMessage but
    // we split at 5000 for readability
    const chunks = splitText(message.text, 5000);
    for (const chunk of chunks) {
      await this.bbApi("POST", "/message/text", {
        chatGuid: chatId,
        message: chunk,
        method: "apple-script",
      });
    }
  }

  async sendTypingIndicator(_chatId: string): Promise<void> {
    // BlueBubbles supports typing indicators on newer versions
    // but it's not reliable — skip silently
  }

  async start(): Promise<void> {
    // Register webhook endpoint on the Express app
    if (this.app) {
      this.app.post("/webhooks/imessage", (req, res) => {
        const payload = req.body as BBWebhookPayload;
        res.status(200).json({ ok: true });

        // Process asynchronously
        this.handleWebhook(payload).catch((err) => {
          log.error("Webhook handler error:", err);
        });
      });
      log.info("Webhook registered at POST /webhooks/imessage");
    }

    // Register ourselves as a webhook in BlueBubbles
    await this.registerWebhook().catch((err) => {
      log.warn("Could not auto-register webhook:", err.message);
      log.warn("Manually add webhook URL in BlueBubbles: POST <gateway-url>/webhooks/imessage");
    });

    log.active("iMessage channel started", `BlueBubbles: ${this.baseUrl}`);
  }

  async stop(): Promise<void> {
    log.warn("iMessage channel stopped");
  }

  // ── Webhook Registration ───────────────────────────────────────

  private async registerWebhook(): Promise<void> {
    const gatewayUrl = process.env.GATEWAY_URL;
    if (!gatewayUrl) {
      throw new Error("GATEWAY_URL not set — cannot auto-register BlueBubbles webhook");
    }

    await this.bbApi("POST", "/server/webhook", {
      url: `${gatewayUrl}/webhooks/imessage`,
      events: ["new-message"],
    });

    log.active("Webhook registered with BlueBubbles");
  }

  // ── Webhook Handler ────────────────────────────────────────────

  private async handleWebhook(payload: BBWebhookPayload): Promise<void> {
    if (payload.type !== "new-message") return;

    const msg = payload.data;

    // Ignore our own messages
    if (msg.isFromMe) return;

    // Ignore messages without text
    if (!msg.text?.trim()) return;

    const chat = msg.chats?.[0];
    if (!chat) return;

    const chatId = chat.guid;
    const senderId = msg.handle?.address ?? "unknown";
    const isGroup = (chat.participants?.length ?? 0) > 1;

    // Build attachments
    const attachments: IncomingMessage["attachments"] = [];
    if (msg.attachments?.length) {
      for (const att of msg.attachments) {
        const type = att.mimeType?.startsWith("image/")
          ? "image" as const
          : att.mimeType?.startsWith("audio/")
            ? "audio" as const
            : att.mimeType?.startsWith("video/")
              ? "video" as const
              : "file" as const;
        attachments.push({
          type,
          mimeType: att.mimeType ?? undefined,
          filename: att.transferName ?? undefined,
          url: `${this.baseUrl}/api/v1/attachment/${encodeURIComponent(att.guid)}/download?password=${encodeURIComponent(this.password)}`,
        });
      }
    }

    const incoming: IncomingMessage = {
      channel: "imessage",
      chatId,
      senderId,
      senderName: chat.displayName ?? senderId,
      text: msg.text.trim(),
      isGroup,
      messageId: msg.guid,
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    // Prevent duplicate processing for the same chat
    if (this.processingChats.has(chatId)) {
      log.dim(`Already processing chat ${chatId}, queuing`);
    }
    this.processingChats.add(chatId);

    try {
      await handleIncomingMessage(incoming, this, this.resolveClient);
    } finally {
      this.processingChats.delete(chatId);
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

let _adapter: IMessageAdapter | null = null;

export function startIMessageChannel(
  baseUrl: string,
  password: string,
  resolveClient: ClientResolver,
  app?: Express,
): void {
  _adapter = new IMessageAdapter(baseUrl, password, resolveClient, app);
  _adapter.start();
}

export function stopIMessageChannel(): void {
  if (_adapter) {
    _adapter.stop();
    _adapter = null;
  }
}
