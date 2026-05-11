// ── Signal Channel (signal-cli REST API) ────────────────────────────
// Connects to Signal via signal-cli's REST API, which provides HTTP
// endpoints for sending/receiving Signal messages.
//
// Requirements:
//  • signal-cli-rest-api running (https://github.com/bbernhard/signal-cli-rest-api)
//  • SIGNAL_API_URL — URL of signal-cli REST API (e.g., http://localhost:8085)
//  • SIGNAL_PHONE_NUMBER — Registered Signal phone number (e.g., +1234567890)
//
// Architecture:
//  • Receives messages via webhook: POST /webhooks/signal
//  • Sends replies via signal-cli REST API
//  • Polls for messages as fallback when webhooks aren't available

import type {
  ChannelAdapter,
  IncomingMessage,
  OutgoingMessage,
  ClientResolver,
} from "./base.js";
import { handleIncomingMessage } from "./base.js";
import { createLogger } from "../utils/logger.js";
import type { Express } from "express";

const log = createLogger("signal");

// ── Signal Types ───────────────────────────────────────────────────

interface SignalMessage {
  envelope: {
    source: string;
    sourceNumber?: string;
    sourceName?: string;
    sourceUuid?: string;
    timestamp: number;
    dataMessage?: {
      timestamp: number;
      message: string | null;
      groupInfo?: { groupId: string; type: string };
      attachments?: Array<{
        contentType: string;
        filename?: string;
        id: string;
        size: number;
      }>;
    };
    syncMessage?: {
      sentMessage?: {
        destination?: string;
        destinationNumber?: string;
        timestamp: number;
        message: string | null;
        groupInfo?: { groupId: string };
      };
    };
  };
  account: string;
}

// ── Signal Adapter ─────────────────────────────────────────────────

export class SignalAdapter implements ChannelAdapter {
  readonly channelType = "signal" as const;
  private apiUrl: string;
  private phoneNumber: string;
  private resolveClient: ClientResolver;
  private app: Express | null;
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    apiUrl: string,
    phoneNumber: string,
    resolveClient: ClientResolver,
    app?: Express,
  ) {
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.phoneNumber = phoneNumber;
    this.resolveClient = resolveClient;
    this.app = app ?? null;
  }

  // ── Signal REST API Layer ────────────────────────────────────────

  private async signalApi<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.apiUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Signal API ${method} ${path}: ${res.status} ${text}`);
    }
    return (await res.json()) as T;
  }

  // ── ChannelAdapter Interface ───────────────────────────────────

  async sendMessage(chatId: string, message: OutgoingMessage): Promise<void> {
    const chunks = splitText(message.text, 4096);
    for (const chunk of chunks) {
      // Determine if sending to group or individual
      if (chatId.startsWith("group:")) {
        const groupId = chatId.replace("group:", "");
        await this.signalApi("POST", `/v2/send`, {
          message: chunk,
          number: this.phoneNumber,
          recipients: [groupId],
        });
      } else {
        await this.signalApi("POST", `/v2/send`, {
          message: chunk,
          number: this.phoneNumber,
          recipients: [chatId],
        });
      }
    }
  }

  async sendTypingIndicator(_chatId: string): Promise<void> {
    // signal-cli REST API doesn't expose typing indicators
  }

  async start(): Promise<void> {
    this.running = true;

    if (this.app) {
      // Register webhook endpoint
      this.app.post("/webhooks/signal", (req, res) => {
        res.status(200).json({ ok: true });
        const payload = req.body as SignalMessage;
        this.handleSignalMessage(payload).catch((err) => {
          log.error("Webhook handler error:", err);
        });
      });
      log.info("Webhook registered at POST /webhooks/signal");
    }

    // Also start polling as fallback (signal-cli may not support webhooks)
    this.startPolling();

    log.active("Signal channel started", `Number: ${this.phoneNumber}`);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    log.warn("Signal channel stopped");
  }

  // ── Polling ──────────────────────────────────────────────────────

  private startPolling(): void {
    const poll = async () => {
      if (!this.running) return;
      try {
        const messages = await this.signalApi<SignalMessage[]>(
          "GET",
          `/v1/receive/${encodeURIComponent(this.phoneNumber)}`,
        );
        for (const msg of messages) {
          this.handleSignalMessage(msg).catch((err) => {
            log.error("Message handler error:", err);
          });
        }
      } catch (err) {
        // Polling failures are expected when webhook mode is active
        log.dim("Poll cycle:", err instanceof Error ? err.message : String(err));
      }
      if (this.running) {
        this.pollTimer = setTimeout(poll, 5000);
      }
    };
    this.pollTimer = setTimeout(poll, 2000);
  }

  // ── Message Handler ──────────────────────────────────────────────

  private async handleSignalMessage(msg: SignalMessage): Promise<void> {
    const env = msg.envelope;

    // Skip sync messages (our own sent messages)
    if (env.syncMessage) return;

    const data = env.dataMessage;
    if (!data) return;

    const text = data.message;
    if (!text?.trim() && !data.attachments?.length) return;

    const senderId = env.sourceNumber ?? env.source;
    const senderName = env.sourceName ?? senderId;
    const isGroup = !!data.groupInfo;
    const chatId = isGroup ? `group:${data.groupInfo!.groupId}` : senderId;

    // Build attachments
    const attachments: IncomingMessage["attachments"] = [];
    if (data.attachments?.length) {
      for (const att of data.attachments) {
        const type = att.contentType.startsWith("image/")
          ? ("image" as const)
          : att.contentType.startsWith("audio/")
            ? ("audio" as const)
            : att.contentType.startsWith("video/")
              ? ("video" as const)
              : ("file" as const);
        attachments.push({
          type,
          mimeType: att.contentType,
          filename: att.filename,
          url: `${this.apiUrl}/v1/attachments/${att.id}`,
        });
      }
    }

    const incoming: IncomingMessage = {
      channel: "signal",
      chatId,
      senderId,
      senderName,
      text: text?.trim() ?? undefined,
      isGroup,
      messageId: String(data.timestamp),
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

let _adapter: SignalAdapter | null = null;

export function startSignalChannel(
  apiUrl: string,
  phoneNumber: string,
  resolveClient: ClientResolver,
  app?: Express,
): void {
  _adapter = new SignalAdapter(apiUrl, phoneNumber, resolveClient, app);
  _adapter.start();
}

export function stopSignalChannel(): void {
  if (_adapter) {
    _adapter.stop();
    _adapter = null;
  }
}
