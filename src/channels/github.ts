// ── GitHub App Channel ────────────────────────────────────────────────
// Receives and processes GitHub webhook events (issues, PRs, comments)
// and routes them to an Astra agent via the shared channel abstraction.
//
// Requirements:
//  • GITHUB_APP_ID — GitHub App ID
//  • GITHUB_WEBHOOK_SECRET — Webhook secret for signature verification
//
// Architecture:
//  • POST /channels/github/webhook — receives GitHub webhook events
//  • X-Hub-Signature-256 header verification (HMAC-SHA256)
//  • Handles: issues, issue_comment, pull_request, pull_request_review_comment
//  • Routes through the shared handleIncomingMessage infrastructure

import type {
  ChannelAdapter,
  IncomingMessage,
  OutgoingMessage,
  ClientResolver,
} from "./base.js";
import { handleIncomingMessage } from "./base.js";
import { createLogger } from "../utils/logger.js";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import express from "express";

const log = createLogger("github-channel");

// ── GitHub Event Types ─────────────────────────────────────────────

export type GitHubEventType =
  | "issues"
  | "issue_comment"
  | "pull_request"
  | "pull_request_review_comment";

const HANDLED_EVENTS: readonly GitHubEventType[] = [
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_review_comment",
];

// ── Channel Config ─────────────────────────────────────────────────

export interface GitHubChannelConfig {
  appId: string;
  webhookSecret: string;
  installationId?: string;
}

// ── Signature Verification ─────────────────────────────────────────

/**
 * Verify GitHub webhook signature (X-Hub-Signature-256 header).
 * Uses timingSafeEqual to prevent timing attacks.
 */
function verifyGitHubSignature(
  payload: Buffer,
  secret: string,
  signature: string,
): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ── Event Text Builder ─────────────────────────────────────────────

/**
 * Build a text summary of the GitHub event for the agent.
 * Returns null for events or actions we don't handle.
 */
function buildEventText(
  eventType: GitHubEventType,
  payload: Record<string, unknown>,
): string | null {
  const repo =
    ((payload.repository as Record<string, unknown>)?.full_name as string) ??
    "unknown/repo";
  const action = (payload.action as string) ?? "unknown";
  const sender =
    ((payload.sender as Record<string, unknown>)?.login as string) ?? "unknown";

  if (eventType === "issues") {
    const issue = payload.issue as Record<string, unknown>;
    const title = (issue?.title as string) ?? "";
    const body = ((issue?.body as string) ?? "").slice(0, 2000);
    const url = (issue?.html_url as string) ?? "";
    return (
      `GitHub issue ${action} in ${repo} by ${sender}:\n` +
      `Title: ${title}\n${body}\nURL: ${url}`
    );
  }

  if (eventType === "issue_comment") {
    const issue = payload.issue as Record<string, unknown>;
    const comment = payload.comment as Record<string, unknown>;
    const title = (issue?.title as string) ?? "";
    const body = ((comment?.body as string) ?? "").slice(0, 2000);
    const url = (comment?.html_url as string) ?? "";
    return (
      `GitHub comment on issue "${title}" in ${repo} by ${sender}:\n` +
      `${body}\nURL: ${url}`
    );
  }

  if (eventType === "pull_request") {
    const pr = payload.pull_request as Record<string, unknown>;
    const title = (pr?.title as string) ?? "";
    const body = ((pr?.body as string) ?? "").slice(0, 2000);
    const url = (pr?.html_url as string) ?? "";
    return (
      `GitHub PR ${action} in ${repo} by ${sender}:\n` +
      `Title: ${title}\n${body}\nURL: ${url}`
    );
  }

  if (eventType === "pull_request_review_comment") {
    const comment = payload.comment as Record<string, unknown>;
    const body = ((comment?.body as string) ?? "").slice(0, 2000);
    const url = (comment?.html_url as string) ?? "";
    return `GitHub PR review comment in ${repo} by ${sender}:\n${body}\nURL: ${url}`;
  }

  return null;
}

// ── GitHub Channel Adapter ─────────────────────────────────────────
// Minimal ChannelAdapter for GitHub — GitHub is event-driven (receive-only),
// so sendMessage and sendTypingIndicator are no-ops unless extended with
// GitHub App REST API posting (installation tokens via JWT).

class GitHubAdapter implements ChannelAdapter {
  readonly channelType = "github" as const;

  async sendMessage(_chatId: string, _message: OutgoingMessage): Promise<void> {
    // GitHub channel is receive-only by default.
    // Posting comments back to GitHub requires GitHub App installation tokens
    // (GitHub JWT → installation access token → REST API POST).
  }

  async sendTypingIndicator(_chatId: string): Promise<void> {
    // GitHub has no typing indicator concept.
  }

  async start(): Promise<void> {
    // Webhook registration is handled at the Express level in startGitHubChannel.
  }

  async stop(): Promise<void> {
    // Express routes cannot be unregistered; lifecycle is managed externally.
  }
}

// ── Lifecycle ──────────────────────────────────────────────────────

let _adapter: GitHubAdapter | null = null;

/**
 * Register the GitHub webhook handler on the Express app.
 * Route: POST /channels/github/webhook
 */
export function startGitHubChannel(
  config: GitHubChannelConfig,
  resolveClient: ClientResolver,
  app: Express,
): void {
  _adapter = new GitHubAdapter();

  app.post(
    "/channels/github/webhook",
    express.raw({ type: "application/json" }),
    async (req: Request, res: Response) => {
      const rawBody = req.body as Buffer;
      const signature =
        (req.headers["x-hub-signature-256"] as string | undefined) ?? "";
      const eventType =
        (req.headers["x-github-event"] as string | undefined) ?? "";
      const deliveryId =
        (req.headers["x-github-delivery"] as string | undefined) ?? "";

      // Verify HMAC-SHA256 signature before touching the payload
      if (!verifyGitHubSignature(rawBody, config.webhookSecret, signature)) {
        log.warn(`Signature mismatch (delivery=${deliveryId})`);
        res.status(401).json({ error: "Invalid signature" });
        return;
      }

      // Parse JSON payload
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(rawBody.toString("utf8")) as Record<
          string,
          unknown
        >;
      } catch {
        res.status(400).json({ error: "Invalid JSON" });
        return;
      }

      // Skip unhandled event types (ping, push, star, workflow_run, etc.)
      if (!HANDLED_EVENTS.includes(eventType as GitHubEventType)) {
        res.status(200).json({ status: "ignored" });
        return;
      }

      // Build human-readable text for the agent
      const text = buildEventText(eventType as GitHubEventType, payload);
      if (!text) {
        res.status(200).json({ status: "ignored" });
        return;
      }

      // Sender login as the stable uid — same user across events
      const senderLogin =
        ((payload.sender as Record<string, unknown>)?.login as string) ??
        "github-actor";

      const incoming: IncomingMessage = {
        channel: "github",
        chatId: `${config.appId}:${deliveryId}`,
        senderId: senderLogin,
        senderName: senderLogin,
        text,
        isGroup: false,
        messageId: deliveryId || undefined,
      };

      try {
        await handleIncomingMessage(incoming, _adapter!, resolveClient);
        res.json({ status: "ok" });
      } catch (err) {
        log.error(
          "Error handling event:",
          err instanceof Error ? err.message : String(err),
        );
        res.status(500).json({ error: "Internal error" });
      }
    },
  );

  log.active("GitHub App channel started", `appId=${config.appId}`);
}

export function stopGitHubChannel(): void {
  _adapter = null;
  log.dim("GitHub channel stopped");
}
