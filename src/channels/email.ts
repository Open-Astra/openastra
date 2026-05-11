// ── Email Channel (SMTP outbound + Postmark inbound webhook) ─────────
// Receives emails via the Postmark Inbound Webhook (JSON POST) and sends
// replies via nodemailer over SMTP — works with any SMTP server (Gmail,
// SendGrid SMTP relay, Mailgun, your own server, etc.).
//
// Inbound setup (Postmark):
//  1. Add an inbound domain in your Postmark account
//  2. Set the webhook URL to: https://your-gateway/webhooks/email
//     (optionally add ?secret=YOUR_EMAIL_WEBHOOK_SECRET for verification)
//  3. Postmark forwards every inbound email as a JSON POST
//
// Required env vars:
//  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM
//
// Optional env vars:
//  EMAIL_WEBHOOK_SECRET — verify inbound requests (recommended)

import { createTransport } from "nodemailer";
import type { Transporter } from "nodemailer";
import type { ChannelAdapter, IncomingMessage, OutgoingMessage, ClientResolver } from "./base.js";
import { handleIncomingMessage } from "./base.js";
import { createLogger } from "../utils/logger.js";
import type { Express, Request, Response } from "express";

const log = createLogger("email");

// ── Postmark Inbound Webhook Payload ──────────────────────────────

interface PostmarkInboundPayload {
  From?: string;
  FromFull?: { Email: string; Name: string; MailboxHash?: string };
  Subject?: string;
  TextBody?: string;
  HtmlBody?: string;
  ReplyTo?: string;
  MessageID?: string;
  To?: string;
  Cc?: string;
  Attachments?: Array<{
    Name: string;
    ContentType: string;
    ContentLength: number;
    /** Base64-encoded attachment content */
    Content?: string;
  }>;
}

// ── Email Adapter ─────────────────────────────────────────────────

export class EmailAdapter implements ChannelAdapter {
  readonly channelType = "email" as const;

  private transporter: Transporter;
  private fromAddress: string;
  private resolveClient: ClientResolver;
  private app: Express | null;
  private webhookSecret: string | undefined;

  /**
   * Per-sender subject cache — so replies arrive as "Re: <original subject>"
   * rather than a new thread. Keyed by normalized sender email.
   */
  private subjectCache = new Map<string, string>();

  constructor(
    smtpConfig: {
      host: string;
      port: number;
      user: string;
      password: string;
      from: string;
      secure?: boolean;
    },
    resolveClient: ClientResolver,
    app?: Express,
    webhookSecret?: string,
  ) {
    this.fromAddress = smtpConfig.from;
    this.resolveClient = resolveClient;
    this.app = app ?? null;
    this.webhookSecret = webhookSecret;

    this.transporter = createTransport({
      host: smtpConfig.host,
      port: smtpConfig.port,
      // Port 465 = implicit TLS; anything else uses STARTTLS
      secure: smtpConfig.secure ?? smtpConfig.port === 465,
      auth: {
        user: smtpConfig.user,
        pass: smtpConfig.password,
      },
    });
  }

  // ── ChannelAdapter Interface ───────────────────────────────────

  async sendMessage(chatId: string, message: OutgoingMessage): Promise<void> {
    // chatId is the recipient's email address
    const cachedSubject = this.subjectCache.get(chatId);
    const subject = cachedSubject ? `Re: ${cachedSubject}` : "Message from Astra";

    await this.transporter.sendMail({
      from: this.fromAddress,
      to: chatId,
      subject,
      text: message.text,
    });

    log.info(`Sent reply to ${chatId}`);
  }

  async sendTypingIndicator(_chatId: string): Promise<void> {
    // Email has no typing indicator concept
  }

  async start(): Promise<void> {
    // Verify SMTP credentials on startup so misconfiguration fails fast
    try {
      await this.transporter.verify();
      log.active("SMTP connection verified", this.fromAddress);
    } catch (err) {
      log.error("SMTP connection failed — check SMTP_HOST/PORT/USER/PASSWORD:", err);
      return;
    }

    if (this.app) {
      this.app.post("/webhooks/email", (req: Request, res: Response) => {
        // Optional webhook secret verification
        // Pass as header X-Webhook-Secret or query param ?secret=
        if (this.webhookSecret) {
          const provided =
            (req.headers["x-webhook-secret"] as string | undefined) ??
            (req.query["secret"] as string | undefined);
          if (provided !== this.webhookSecret) {
            log.warn("Rejected inbound email webhook — invalid secret");
            res.sendStatus(403);
            return;
          }
        }

        // Acknowledge before processing (Postmark retries on non-2xx)
        res.sendStatus(200);

        this.handleInbound(req.body as PostmarkInboundPayload).catch((err) => {
          log.error("Inbound email handler error:", err);
        });
      });

      log.info("Inbound webhook registered at POST /webhooks/email");
    }

    log.active("Email channel started");
  }

  async stop(): Promise<void> {
    this.transporter.close();
    log.warn("Email channel stopped");
  }

  // ── Inbound Handler ───────────────────────────────────────────

  private async handleInbound(payload: PostmarkInboundPayload): Promise<void> {
    const fromEmail = (payload.FromFull?.Email ?? payload.From ?? "").toLowerCase().trim();
    const fromName = payload.FromFull?.Name ?? payload.From ?? fromEmail;

    if (!fromEmail) {
      log.warn("Inbound email has no From address — ignoring");
      return;
    }

    // Prefer plain text; strip HTML as fallback
    const text = (payload.TextBody?.trim()) || stripHtml(payload.HtmlBody ?? "").trim();

    if (!text) {
      log.dim(`Inbound email from ${fromEmail} has no text body — ignoring`);
      return;
    }

    // Cache the base subject for reply threading
    if (payload.Subject) {
      const base = payload.Subject.replace(/^(re|fwd?):\s*/gi, "").trim();
      if (base) this.subjectCache.set(fromEmail, base);
    }

    // Build attachments
    const attachments: IncomingMessage["attachments"] = [];
    for (const att of payload.Attachments ?? []) {
      const mime = att.ContentType ?? "application/octet-stream";
      const type = mime.startsWith("image/")
        ? ("image" as const)
        : mime.startsWith("audio/")
          ? ("audio" as const)
          : mime.startsWith("video/")
            ? ("video" as const)
            : ("file" as const);
      attachments.push({
        type,
        mimeType: mime,
        filename: att.Name,
        data: att.Content, // Base64-encoded
      });
    }

    const incoming: IncomingMessage = {
      channel: "email",
      chatId: fromEmail,
      senderId: fromEmail,
      senderName: fromName,
      text,
      isGroup: false,
      messageId: payload.MessageID,
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    log.info(`Inbound from ${fromName} <${fromEmail}>: ${payload.Subject ?? "(no subject)"}`);
    await handleIncomingMessage(incoming, this, this.resolveClient);
  }
}

// ── Helpers ────────────────────────────────────────────────────────

/** Strip HTML tags for plain-text fallback when TextBody is absent. */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Lifecycle Exports ──────────────────────────────────────────────

let _adapter: EmailAdapter | null = null;

export function startEmailChannel(
  smtpConfig: {
    host: string;
    port: number;
    user: string;
    password: string;
    from: string;
    secure?: boolean;
  },
  resolveClient: ClientResolver,
  app?: Express,
  webhookSecret?: string,
): void {
  _adapter = new EmailAdapter(smtpConfig, resolveClient, app, webhookSecret);
  _adapter.start();
}

export function stopEmailChannel(): void {
  if (_adapter) {
    _adapter.stop();
    _adapter = null;
  }
}
