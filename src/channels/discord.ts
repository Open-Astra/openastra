// ── Discord Channel (Bot Gateway) ───────────────────────────────────
// Full-featured Discord bot using the Discord Gateway (WebSocket) for
// real-time message handling and the REST API for sending responses.
//
// Requirements:
//  • DISCORD_BOT_TOKEN — Bot token from Discord Developer Portal
//  • Bot needs MESSAGE_CONTENT intent enabled in Developer Portal
//
// Architecture:
//  • Connects to Discord Gateway via WebSocket for real-time events
//  • Sends messages via Discord REST API v10
//  • Supports DMs, server channels, threads
//  • @mention detection in servers (only responds when mentioned)
//  • Automatic message splitting for Discord's 2000-char limit

import type {
  ChannelAdapter,
  IncomingMessage,
  OutgoingMessage,
  ClientResolver,
} from "./base.js";
import { handleIncomingMessage } from "./base.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("discord");

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";

// ── Discord Types ──────────────────────────────────────────────────

interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: { id: string; username: string; bot?: boolean };
  content: string;
  timestamp: string;
  attachments?: Array<{
    id: string;
    filename: string;
    content_type?: string;
    url: string;
  }>;
  mentions?: Array<{ id: string }>;
  message_reference?: { message_id: string };
}

interface DiscordGatewayPayload {
  op: number;
  d: unknown;
  s?: number;
  t?: string;
}

interface DiscordReadyEvent {
  user: { id: string; username: string };
  session_id: string;
}

// ── Discord Adapter ────────────────────────────────────────────────

export class DiscordAdapter implements ChannelAdapter {
  readonly channelType = "discord" as const;
  private token: string;
  private resolveClient: ClientResolver;
  private running = false;
  private ws: WebSocket | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private lastSequence: number | null = null;
  private botUserId: string | null = null;

  constructor(token: string, resolveClient: ClientResolver) {
    this.token = token;
    this.resolveClient = resolveClient;
  }

  // ── Discord REST API ─────────────────────────────────────────────

  private async discordApi<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const res = await fetch(`${DISCORD_API}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bot ${this.token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Discord API ${method} ${path}: ${res.status} ${text}`);
    }
    return (await res.json()) as T;
  }

  // ── ChannelAdapter Interface ───────────────────────────────────

  async sendMessage(chatId: string, message: OutgoingMessage): Promise<void> {
    const chunks = splitText(message.text, 2000);
    for (const chunk of chunks) {
      await this.discordApi("POST", `/channels/${chatId}/messages`, {
        content: chunk,
        ...(message.replyTo
          ? { message_reference: { message_id: message.replyTo } }
          : {}),
      });
    }
  }

  async sendTypingIndicator(chatId: string): Promise<void> {
    await this.discordApi("POST", `/channels/${chatId}/typing`, {});
  }

  async start(): Promise<void> {
    this.running = true;
    this.connectGateway();
    log.active("Discord channel starting...");
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.ws) {
      this.ws.close(1000);
      this.ws = null;
    }
    log.warn("Discord channel stopped");
  }

  // ── Gateway WebSocket ────────────────────────────────────────────

  private connectGateway(): void {
    this.ws = new WebSocket(DISCORD_GATEWAY);

    this.ws.addEventListener("open", () => {
      log.dim("Gateway connected");
    });

    this.ws.addEventListener("message", (event) => {
      const payload = JSON.parse(String(event.data)) as DiscordGatewayPayload;
      this.handleGatewayPayload(payload);
    });

    this.ws.addEventListener("close", (event) => {
      log.warn(`Gateway closed: ${event.code} ${event.reason}`);
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }
      // Reconnect after a delay
      if (this.running) {
        setTimeout(() => this.connectGateway(), 5000);
      }
    });

    this.ws.addEventListener("error", (err) => {
      log.error("Gateway error:", err);
    });
  }

  private handleGatewayPayload(payload: DiscordGatewayPayload): void {
    if (payload.s !== undefined) this.lastSequence = payload.s;

    switch (payload.op) {
      case 10: {
        // Hello — start heartbeating and identify
        const { heartbeat_interval } = payload.d as { heartbeat_interval: number };
        this.startHeartbeat(heartbeat_interval);
        this.identify();
        break;
      }
      case 11:
        // Heartbeat ACK
        break;
      case 7:
        // Reconnect requested
        if (this.ws) this.ws.close(4000);
        break;
      case 9:
        // Invalid session — re-identify after delay
        setTimeout(() => this.identify(), 3000);
        break;
      case 0:
        // Dispatch event
        this.handleDispatch(payload.t!, payload.d);
        break;
    }
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = setInterval(() => {
      this.sendGateway({ op: 1, d: this.lastSequence });
    }, intervalMs);
  }

  private identify(): void {
    this.sendGateway({
      op: 2,
      d: {
        token: this.token,
        intents: (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15), // GUILDS, GUILD_MESSAGES, DM_MESSAGES, MESSAGE_CONTENT
        properties: {
          os: "linux",
          browser: "astra",
          device: "astra",
        },
      },
    });
  }

  private sendGateway(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  // ── Event Dispatch ───────────────────────────────────────────────

  private handleDispatch(eventName: string, data: unknown): void {
    switch (eventName) {
      case "READY": {
        const ready = data as DiscordReadyEvent;
        this.botUserId = ready.user.id;
        log.active("Bot ready", `@${ready.user.username}`);
        break;
      }
      case "MESSAGE_CREATE": {
        const msg = data as DiscordMessage;
        this.handleMessage(msg).catch((err) => {
          log.error("Message handler error:", err);
        });
        break;
      }
    }
  }

  private async handleMessage(msg: DiscordMessage): Promise<void> {
    // Ignore bot messages
    if (msg.author.bot) return;

    const isGuild = !!msg.guild_id;
    const text = msg.content;

    // In servers, only respond when @mentioned or in DMs
    if (isGuild) {
      const mentioned = msg.mentions?.some((m) => m.id === this.botUserId);
      if (!mentioned) return;
    }

    // Strip bot mention from text
    let cleanText = text;
    if (this.botUserId) {
      cleanText = cleanText.replace(new RegExp(`<@!?${this.botUserId}>`, "g"), "").trim();
    }

    if (!cleanText && !msg.attachments?.length) return;

    // Build attachments
    const attachments: IncomingMessage["attachments"] = [];
    if (msg.attachments?.length) {
      for (const att of msg.attachments) {
        const type = att.content_type?.startsWith("image/")
          ? ("image" as const)
          : att.content_type?.startsWith("audio/")
            ? ("audio" as const)
            : att.content_type?.startsWith("video/")
              ? ("video" as const)
              : ("file" as const);
        attachments.push({
          type,
          mimeType: att.content_type,
          filename: att.filename,
          url: att.url,
        });
      }
    }

    const incoming: IncomingMessage = {
      channel: "discord",
      chatId: msg.channel_id,
      senderId: msg.author.id,
      senderName: msg.author.username,
      text: cleanText || undefined,
      isGroup: isGuild,
      messageId: msg.id,
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    // Send typing indicator every 5s during processing
    const typingInterval = setInterval(() => {
      this.sendTypingIndicator(incoming.chatId).catch(() => {});
    }, 5000);

    try {
      await handleIncomingMessage(incoming, this, this.resolveClient);
    } finally {
      clearInterval(typingInterval);
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

let _adapter: DiscordAdapter | null = null;

export function startDiscordBot(
  token: string,
  resolveClient: ClientResolver,
): void {
  _adapter = new DiscordAdapter(token, resolveClient);
  _adapter.start();
}

export function stopDiscordBot(): void {
  if (_adapter) {
    _adapter.stop();
    _adapter = null;
  }
}
