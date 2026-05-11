// ── Microsoft Teams Channel (Bot Framework v3) ──────────────────────
// Connects to Microsoft Teams via the Azure Bot Service / Bot Framework.
// Receives Activity objects via HTTP endpoint and sends replies through
// the Bot Connector REST API.
//
// Requirements:
//  • TEAMS_APP_ID     — Microsoft App ID (Azure App Registration)
//  • TEAMS_APP_PASSWORD — Microsoft App Password (client secret)
//
// Architecture:
//  • Receives events: POST /webhooks/teams
//  • Incoming JWT verified against Microsoft's JWKS (RS256, aud = App ID)
//  • Outgoing replies: OAuth2 client_credentials → Bot Connector REST API
//  • Supports DMs (personal), group chats, and channel @mentions

import type {
  ChannelAdapter,
  IncomingMessage,
  OutgoingMessage,
  ClientResolver,
} from "./base.js";
import { handleIncomingMessage } from "./base.js";
import { createLogger } from "../utils/logger.js";
import type { Express, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";

const log = createLogger("teams");

// ── Microsoft Bot Framework JWT endpoints ──────────────────────────
// Teams can send tokens signed by either key set depending on auth flow.
const JWKS_BOT_FRAMEWORK = createRemoteJWKSet(
  new URL("https://login.botframework.com/v1/.well-known/keys"),
);
const JWKS_MSA = createRemoteJWKSet(
  new URL("https://login.microsoftonline.com/botframework.com/discovery/v2.0/keys"),
);

const TOKEN_ENDPOINT =
  "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token";

// ── Bot Framework Activity Types ───────────────────────────────────

interface TeamsActivity {
  type: string; // "message" | "conversationUpdate" | "typing" | etc.
  id: string;
  timestamp: string;
  serviceUrl: string;
  channelId: string;
  from: { id: string; name?: string; aadObjectId?: string };
  conversation: {
    id: string;
    isGroup?: boolean;
    conversationType?: string; // "personal" | "channel" | "groupChat"
    tenantId?: string;
  };
  recipient: { id: string; name?: string };
  text?: string;
  attachments?: Array<{
    contentType: string;
    content?: unknown;
    contentUrl?: string;
    name?: string;
  }>;
  membersAdded?: Array<{ id: string; name?: string }>;
  channelData?: {
    teamsChannelId?: string;
    teamsTeamId?: string;
    channel?: { id: string; name?: string };
  };
}

interface OutgoingActivity {
  type: string;
  text?: string;
  replyToId?: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

// ── Teams Adapter ──────────────────────────────────────────────────

export class TeamsAdapter implements ChannelAdapter {
  readonly channelType = "teams" as const;
  private appId: string;
  private appPassword: string;
  private resolveClient: ClientResolver;
  private app: Express | null;

  // Cached outgoing token (client_credentials grant)
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(
    appId: string,
    appPassword: string,
    resolveClient: ClientResolver,
    app?: Express,
  ) {
    this.appId = appId;
    this.appPassword = appPassword;
    this.resolveClient = resolveClient;
    this.app = app ?? null;
  }

  // ── Outgoing Auth ────────────────────────────────────────────────

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && now < this.tokenExpiresAt - 30_000) {
      return this.cachedToken;
    }

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.appId,
      client_secret: this.appPassword,
      scope: "https://api.botframework.com/.default",
    });

    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Teams token fetch failed: ${res.status} ${text}`);
    }

    const data = (await res.json()) as TokenResponse;
    this.cachedToken = data.access_token;
    this.tokenExpiresAt = now + data.expires_in * 1000;
    return this.cachedToken;
  }

  // ── Incoming JWT Verification ─────────────────────────────────────
  // Microsoft sends an RS256 JWT in the Authorization header. Try both
  // JWKS endpoints since the key set varies by auth flow / token version.

  private async verifyToken(authHeader: string | undefined): Promise<boolean> {
    if (!authHeader?.startsWith("Bearer ")) return false;
    const token = authHeader.slice(7);

    for (const jwks of [JWKS_BOT_FRAMEWORK, JWKS_MSA]) {
      try {
        await jwtVerify(token, jwks, {
          audience: this.appId,
          algorithms: ["RS256"],
        });
        return true;
      } catch {
        // Try next key set
      }
    }
    return false;
  }

  // ── Bot Connector REST API ───────────────────────────────────────

  private async sendActivity(
    serviceUrl: string,
    conversationId: string,
    activity: OutgoingActivity,
  ): Promise<void> {
    const token = await this.getAccessToken();
    const url = `${serviceUrl.replace(/\/$/, "")}/v3/conversations/${encodeURIComponent(conversationId)}/activities`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(activity),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Teams send activity failed: ${res.status} ${text}`);
    }
  }

  // ── ChannelAdapter Interface ─────────────────────────────────────

  async sendMessage(chatId: string, message: OutgoingMessage): Promise<void> {
    // chatId is encoded as "serviceUrl|conversationId"
    const separatorIdx = chatId.indexOf("|");
    if (separatorIdx === -1) throw new Error(`Invalid Teams chatId: ${chatId}`);
    const serviceUrl = chatId.slice(0, separatorIdx);
    const conversationId = chatId.slice(separatorIdx + 1);

    const chunks = splitText(message.text, 4000);
    for (const chunk of chunks) {
      await this.sendActivity(serviceUrl, conversationId, {
        type: "message",
        text: chunk,
        ...(message.replyTo ? { replyToId: message.replyTo } : {}),
      });
    }
  }

  async sendTypingIndicator(chatId: string): Promise<void> {
    try {
      const separatorIdx = chatId.indexOf("|");
      if (separatorIdx === -1) return;
      const serviceUrl = chatId.slice(0, separatorIdx);
      const conversationId = chatId.slice(separatorIdx + 1);
      await this.sendActivity(serviceUrl, conversationId, { type: "typing" });
    } catch {
      // Non-fatal
    }
  }

  async start(): Promise<void> {
    if (this.app) {
      this.app.post("/webhooks/teams", async (req: Request, res: Response) => {
        // Verify JWT
        if (!(await this.verifyToken(req.headers.authorization))) {
          log.warn("Unauthorized request — invalid JWT");
          res.sendStatus(401);
          return;
        }

        res.sendStatus(200); // Acknowledge immediately

        const activity = req.body as TeamsActivity;
        this.handleActivity(activity).catch((err) => {
          log.error("Activity handler error:", err);
        });
      });
      log.info("Webhook registered at POST /webhooks/teams");
    }

    log.active("Microsoft Teams channel started");
  }

  async stop(): Promise<void> {
    log.warn("Teams channel stopped");
  }

  // ── Activity Handler ─────────────────────────────────────────────

  private async handleActivity(activity: TeamsActivity): Promise<void> {
    if (activity.type !== "message") return;

    const text = activity.text?.trim() ?? "";
    const { from, conversation, serviceUrl, id: messageId } = activity;

    if (!from?.id) return;

    // Strip bot @mention from text (Teams includes the bot name in @mentions)
    const cleanText = text
      .replace(/<at>[^<]*<\/at>/gi, "") // remove <at>BotName</at> tags
      .trim();

    if (!cleanText && !activity.attachments?.length) return;

    // Encode serviceUrl + conversationId as chatId (pipe-separated)
    const chatId = `${serviceUrl}|${conversation.id}`;

    const isGroup =
      conversation.isGroup === true ||
      conversation.conversationType === "channel" ||
      conversation.conversationType === "groupChat";

    // Build attachments
    const attachments: IncomingMessage["attachments"] = [];
    if (activity.attachments?.length) {
      for (const att of activity.attachments) {
        if (att.contentType === "text/html") continue; // Skip Teams HTML wrapping
        const attType = att.contentType.startsWith("image/")
          ? ("image" as const)
          : att.contentType.startsWith("audio/")
            ? ("audio" as const)
            : att.contentType.startsWith("video/")
              ? ("video" as const)
              : ("file" as const);
        attachments.push({
          type: attType,
          mimeType: att.contentType,
          filename: att.name,
          url: att.contentUrl,
        });
      }
    }

    const incoming: IncomingMessage = {
      channel: "teams",
      chatId,
      senderId: from.id,
      senderName: from.name ?? from.id,
      text: cleanText || undefined,
      isGroup,
      messageId,
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

let _adapter: TeamsAdapter | null = null;

export function startTeamsChannel(
  appId: string,
  appPassword: string,
  resolveClient: ClientResolver,
  app?: Express,
): void {
  _adapter = new TeamsAdapter(appId, appPassword, resolveClient, app);
  _adapter.start();
}

export function stopTeamsChannel(): void {
  if (_adapter) {
    _adapter.stop();
    _adapter = null;
  }
}
