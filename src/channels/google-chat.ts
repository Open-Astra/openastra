// ── Google Chat Channel ─────────────────────────────────────────────
// Connects to Google Chat via the Google Chat API. Receives messages
// through HTTP endpoint (push subscription) and sends replies via REST.
//
// Requirements:
//  • Google Cloud project with Chat API enabled
//  • GOOGLE_CHAT_SERVICE_ACCOUNT_KEY — Path to service account JSON key
//  • Or: GOOGLE_APPLICATION_CREDENTIALS env var already set
//  • Chat app configured in Google Cloud Console with HTTP endpoint
//
// Architecture:
//  • Receives events: POST /webhooks/google-chat
//  • Sends replies via Google Chat REST API v1
//  • Supports DMs and spaces (group chats)

import type {
  ChannelAdapter,
  IncomingMessage,
  OutgoingMessage,
  ClientResolver,
} from "./base.js";
import { handleIncomingMessage } from "./base.js";
import { createLogger } from "../utils/logger.js";
import type { Express } from "express";
import { readFile } from "node:fs/promises";
import { createSign } from "node:crypto";

const log = createLogger("google-chat");

const CHAT_API = "https://chat.googleapis.com/v1";

// ── Google Chat Types ──────────────────────────────────────────────

interface GoogleChatEvent {
  type: string; // "MESSAGE", "ADDED_TO_SPACE", "REMOVED_FROM_SPACE"
  eventTime: string;
  message?: {
    name: string; // "spaces/{space}/messages/{message}"
    sender: {
      name: string; // "users/{user}"
      displayName: string;
      type: string; // "HUMAN" or "BOT"
    };
    text: string;
    thread?: { name: string };
    space: {
      name: string;
      type: string; // "DM" or "ROOM" or "SPACE"
      displayName?: string;
    };
    attachment?: Array<{
      name: string;
      contentName: string;
      contentType: string;
      attachmentDataRef?: { resourceName: string };
      downloadUri?: string;
    }>;
    argumentText?: string; // text without @mention
  };
  space?: {
    name: string;
    type: string;
    displayName?: string;
  };
  user?: {
    name: string;
    displayName: string;
  };
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri: string;
}

// ── Google Chat Adapter ────────────────────────────────────────────

export class GoogleChatAdapter implements ChannelAdapter {
  readonly channelType = "google-chat" as const;
  private serviceAccountKeyPath: string | undefined;
  private resolveClient: ClientResolver;
  private app: Express | null;
  private accessToken: string | null = null;
  private tokenExpiry = 0;
  private serviceAccount: ServiceAccountKey | null = null;

  constructor(
    resolveClient: ClientResolver,
    serviceAccountKeyPath?: string,
    app?: Express,
  ) {
    this.serviceAccountKeyPath = serviceAccountKeyPath;
    this.resolveClient = resolveClient;
    this.app = app ?? null;
  }

  // ── Auth ─────────────────────────────────────────────────────────

  private async loadServiceAccount(): Promise<ServiceAccountKey> {
    if (this.serviceAccount) return this.serviceAccount;

    const keyPath =
      this.serviceAccountKeyPath ?? process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!keyPath) {
      throw new Error("No Google service account key configured");
    }

    const raw = await readFile(keyPath, "utf-8");
    this.serviceAccount = JSON.parse(raw) as ServiceAccountKey;
    return this.serviceAccount;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const sa = await this.loadServiceAccount();

    // Build JWT for token exchange
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: sa.client_email,
        scope: "https://www.googleapis.com/auth/chat.bot",
        aud: sa.token_uri,
        iat: now,
        exp: now + 3600,
      }),
    ).toString("base64url");

    const signInput = `${header}.${payload}`;
    const signer = createSign("RSA-SHA256");
    signer.update(signInput);
    const signature = signer.sign(sa.private_key, "base64url");
    const jwt = `${signInput}.${signature}`;

    // Exchange JWT for access token
    const res = await fetch(sa.token_uri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Token exchange failed: ${res.status} ${text}`);
    }

    const tokenData = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = tokenData.access_token;
    this.tokenExpiry = Date.now() + (tokenData.expires_in - 60) * 1000;
    return this.accessToken;
  }

  // ── Google Chat API ──────────────────────────────────────────────

  private async chatApi<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const token = await this.getAccessToken();
    const res = await fetch(`${CHAT_API}/${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Google Chat API ${method} ${path}: ${res.status} ${text}`);
    }
    return (await res.json()) as T;
  }

  // ── ChannelAdapter Interface ───────────────────────────────────

  async sendMessage(chatId: string, message: OutgoingMessage): Promise<void> {
    const chunks = splitText(message.text, 4096);
    for (const chunk of chunks) {
      const body: Record<string, unknown> = { text: chunk };
      if (message.replyTo) {
        body.thread = { name: message.replyTo };
      }
      await this.chatApi("POST", `${chatId}/messages`, body);
    }
  }

  async sendTypingIndicator(_chatId: string): Promise<void> {
    // Google Chat API doesn't support typing indicators for bots
  }

  async start(): Promise<void> {
    // Preload service account
    try {
      await this.loadServiceAccount();
      log.info("Service account loaded");
    } catch (err) {
      log.warn("Service account not preloaded:", err instanceof Error ? err.message : String(err));
    }

    if (this.app) {
      this.app.post("/webhooks/google-chat", (req, res) => {
        const event = req.body as GoogleChatEvent;

        // Respond synchronously for ADDED_TO_SPACE
        if (event.type === "ADDED_TO_SPACE") {
          const name = event.user?.displayName ?? "there";
          res.status(200).json({
            text: `Hello ${name}! I'm ready to help. Just send me a message.`,
          });
          return;
        }

        // For messages, acknowledge and process async
        res.status(200).json({});
        if (event.type === "MESSAGE") {
          this.handleEvent(event).catch((err) => {
            log.error("Event handler error:", err);
          });
        }
      });
      log.info("Webhook registered at POST /webhooks/google-chat");
    }

    log.active("Google Chat channel started");
  }

  async stop(): Promise<void> {
    log.warn("Google Chat channel stopped");
  }

  // ── Event Handler ────────────────────────────────────────────────

  private async handleEvent(event: GoogleChatEvent): Promise<void> {
    const msg = event.message;
    if (!msg) return;

    // Ignore bot messages
    if (msg.sender.type === "BOT") return;

    // Use argumentText (mention-stripped) if available, else full text
    const text = msg.argumentText?.trim() ?? msg.text?.trim();
    if (!text && !msg.attachment?.length) return;

    const spaceName = msg.space.name;
    const isDM = msg.space.type === "DM";
    const senderId = msg.sender.name;
    const senderName = msg.sender.displayName;

    // Build attachments
    const attachments: IncomingMessage["attachments"] = [];
    if (msg.attachment?.length) {
      for (const att of msg.attachment) {
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
          filename: att.contentName,
          url: att.downloadUri,
        });
      }
    }

    const incoming: IncomingMessage = {
      channel: "google-chat",
      chatId: spaceName,
      senderId,
      senderName,
      text: text ?? undefined,
      isGroup: !isDM,
      messageId: msg.thread?.name ?? msg.name,
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

let _adapter: GoogleChatAdapter | null = null;

export function startGoogleChatChannel(
  resolveClient: ClientResolver,
  serviceAccountKeyPath?: string,
  app?: Express,
): void {
  _adapter = new GoogleChatAdapter(resolveClient, serviceAccountKeyPath, app);
  _adapter.start();
}

export function stopGoogleChatChannel(): void {
  if (_adapter) {
    _adapter.stop();
    _adapter = null;
  }
}
