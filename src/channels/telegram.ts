// ── Telegram Channel ────────────────────────────────────────────────
// Full-featured Telegram bot using the shared channel abstraction.
// Routes messages through the agent loop with Postgres-backed sessions,
// Typesense semantic memory search, and per-chat agent routing.
//
// Features beyond OpenClaw:
//  • /memory <query> — semantic search across conversation history
//  • /usage — real token cost tracking from billing_usage table
//  • /switch <agent> — per-chat agent routing (persisted in Postgres)
//  • Automatic typing indicators during inference
//  • Smart message splitting with Markdown fallback
//  • Group chat support with @mention detection

import type {
  ChannelAdapter,
  IncomingMessage,
  OutgoingMessage,
  ClientResolver,
} from "./base.js";
import { handleIncomingMessage } from "./base.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("telegram");

// ── Telegram API Types ─────────────────────────────────────────────

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: {
    id: string;
    from: TelegramUser;
    message?: TelegramMessage;
    data?: string;
  };
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number; type: string; title?: string };
  text?: string;
  caption?: string;
  date: number;
  photo?: Array<{ file_id: string; width: number; height: number }>;
  document?: { file_id: string; file_name?: string; mime_type?: string };
  voice?: { file_id: string; duration: number; mime_type?: string };
  audio?: { file_id: string; duration: number; mime_type?: string; file_name?: string };
  reply_to_message?: TelegramMessage;
}

interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  is_bot: boolean;
}

interface TelegramResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

// ── Telegram Adapter ───────────────────────────────────────────────

export class TelegramAdapter implements ChannelAdapter {
  readonly channelType = "telegram" as const;
  private token: string;
  private resolveClient: ClientResolver;
  private running = false;
  private offset = 0;
  private botUsername: string | undefined;

  constructor(token: string, resolveClient: ClientResolver) {
    this.token = token;
    this.resolveClient = resolveClient;
  }

  // ── API Layer ──────────────────────────────────────────────────

  private apiUrl(method: string): string {
    return `https://api.telegram.org/bot${this.token}/${method}`;
  }

  private async api<T>(method: string, body?: Record<string, unknown>): Promise<T> {
    const res = await fetch(this.apiUrl(method), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json()) as TelegramResponse<T>;
    if (!data.ok) throw new Error(`Telegram API ${method}: ${data.description}`);
    return data.result;
  }

  // ── ChannelAdapter Interface ───────────────────────────────────

  async sendMessage(chatId: string, message: OutgoingMessage): Promise<void> {
    const chunks = splitText(message.text, 4000);
    for (const chunk of chunks) {
      await this.api("sendMessage", {
        chat_id: chatId,
        text: chunk,
        parse_mode: "Markdown",
        ...(message.replyTo ? { reply_to_message_id: parseInt(message.replyTo, 10) } : {}),
      }).catch(() => {
        // Retry without Markdown if parsing fails
        return this.api("sendMessage", {
          chat_id: chatId,
          text: chunk,
          ...(message.replyTo ? { reply_to_message_id: parseInt(message.replyTo, 10) } : {}),
        });
      });
    }
  }

  async sendTypingIndicator(chatId: string): Promise<void> {
    await this.api("sendChatAction", { chat_id: chatId, action: "typing" });
  }

  async start(): Promise<void> {
    this.running = true;

    // Clear any stale webhook so long polling works
    try {
      await this.api("deleteWebhook", { drop_pending_updates: false });
    } catch {
      // ignore — webhook may not exist
    }

    // Get bot info for @mention detection in groups
    try {
      const me = await this.api<{ username?: string }>("getMe");
      this.botUsername = me.username;
      log.active(`Bot started`, `@${this.botUsername}`);
    } catch (err) {
      log.error("Failed to get bot info:", err);
    }

    // Start long-polling loop
    this.pollLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    log.warn("Stopping Telegram bot");
  }

  // ── Long Polling ───────────────────────────────────────────────

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.api<TelegramUpdate[]>("getUpdates", {
          offset: this.offset,
          timeout: 30,
          allowed_updates: ["message", "edited_message", "callback_query"],
        });

        for (const update of updates) {
          this.offset = update.update_id + 1;
          this.handleUpdate(update).catch((err) => {
            log.error("Update error:", err);
          });
        }
      } catch (err) {
        log.error("Poll error:", err);
        await sleep(5000);
      }
    }
  }

  // ── Update Handler ─────────────────────────────────────────────

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const raw = update.message ?? update.edited_message;
    if (!raw) return;

    const text = raw.text ?? raw.caption;
    const isGroup = raw.chat.type === "group" || raw.chat.type === "supergroup";

    // In groups, only respond to @mentions or replies to the bot
    if (isGroup && text && !text.startsWith("/")) {
      const mentioned = this.botUsername && text.includes(`@${this.botUsername}`);
      const repliedToBot = raw.reply_to_message?.from?.username === this.botUsername;
      if (!mentioned && !repliedToBot) return;
    }

    // Strip bot mention from text
    let cleanText = text ?? "";
    if (this.botUsername) {
      cleanText = cleanText.replace(new RegExp(`@${this.botUsername}`, "gi"), "").trim();
    }

    if (!cleanText && !raw.photo?.length && !raw.document && !raw.voice && !raw.audio) return;

    // Build attachments
    const attachments: IncomingMessage["attachments"] = [];
    if (raw.photo?.length) {
      const largest = raw.photo[raw.photo.length - 1]!;
      attachments.push({
        type: "image",
        url: await this.getFileUrl(largest.file_id),
      });
    }
    if (raw.document) {
      attachments.push({
        type: "file",
        filename: raw.document.file_name,
        mimeType: raw.document.mime_type,
        url: await this.getFileUrl(raw.document.file_id),
      });
    }
    if (raw.voice || raw.audio) {
      const audio = raw.voice ?? raw.audio!;
      attachments.push({
        type: "audio",
        mimeType: audio.mime_type,
        url: await this.getFileUrl(audio.file_id),
      });
    }

    const incoming: IncomingMessage = {
      channel: "telegram",
      chatId: String(raw.chat.id),
      senderId: String(raw.from?.id ?? raw.chat.id),
      senderName: raw.from
        ? [raw.from.first_name, raw.from.last_name].filter(Boolean).join(" ")
        : "Unknown",
      text: cleanText || undefined,
      isGroup,
      messageId: String(raw.message_id),
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    // Send typing indicator every 4 seconds during processing
    const typingInterval = setInterval(() => {
      this.sendTypingIndicator(incoming.chatId).catch(() => {});
    }, 4000);

    try {
      await handleIncomingMessage(incoming, this, this.resolveClient);
    } finally {
      clearInterval(typingInterval);
    }
  }

  // ── File URL Resolution ────────────────────────────────────────

  private async getFileUrl(fileId: string): Promise<string> {
    try {
      const file = await this.api<{ file_path?: string }>("getFile", { file_id: fileId });
      if (file.file_path) {
        return `https://api.telegram.org/file/bot${this.token}/${file.file_path}`;
      }
    } catch {
      // Ignore — URL will be undefined
    }
    return "";
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Legacy Exports ─────────────────────────────────────────────────
// Backward-compatible start/stop for existing gateway bootstrap.

let _adapter: TelegramAdapter | null = null;

export function startTelegramBot(
  token: string,
  resolveClient: ClientResolver,
): void {
  _adapter = new TelegramAdapter(token, resolveClient);
  _adapter.start();
}

export function stopTelegramBot(): void {
  if (_adapter) {
    _adapter.stop();
    _adapter = null;
  }
}
