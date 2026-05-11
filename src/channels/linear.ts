// ── Linear Channel ──────────────────────────────────────────────────
// Receives Linear webhook events (issues, comments, labels) and routes
// them to an Astra agent via the shared channel abstraction. Bidirectional:
// agent responses are posted back as Linear comments via the GraphQL API.
//
// Requirements:
//  • LINEAR_WEBHOOK_SECRET — Webhook signing secret
//  • LINEAR_API_KEY       — API key for posting comments back
//
// Architecture:
//  • POST /channels/linear/webhook — receives Linear webhook events
//  • Linear-Signature header verification (HMAC-SHA256, raw hex)
//  • Handles: Issue, Comment, IssueLabel
//  • Label-based agent routing via linear_label_agent_mappings table
//  • Deduplication via linear_webhook_events table
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
import { getPool } from "../config/postgres.js";

const log = createLogger("linear-channel");

// ── Linear Event Types ─────────────────────────────────────────────

export type LinearEventType = "Issue" | "Comment" | "IssueLabel";

const HANDLED_EVENTS: readonly LinearEventType[] = [
  "Issue",
  "Comment",
  "IssueLabel",
];

// ── Channel Config ─────────────────────────────────────────────────

export interface LinearChannelConfig {
  webhookSecret: string;
  apiKey: string;
}

// ── Signature Verification ─────────────────────────────────────────

/**
 * Verify Linear webhook signature (Linear-Signature header).
 * Linear sends raw hex HMAC-SHA256 (no "sha256=" prefix).
 * Uses timingSafeEqual to prevent timing attacks.
 */
function verifyLinearSignature(
  rawBody: Buffer,
  secret: string,
  signature: string,
): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ── Event Text Builder ─────────────────────────────────────────────

/**
 * Build a text summary of the Linear event for the agent.
 * Returns null for events or actions we don't handle.
 */
function buildLinearEventText(
  type: LinearEventType,
  action: string,
  payload: Record<string, unknown>,
): string | null {
  const data = payload.data as Record<string, unknown> | undefined;
  if (!data) return null;

  const actorName =
    ((payload as Record<string, unknown>).actor as Record<string, unknown>)
      ?.name ??
    ((payload as Record<string, unknown>).createdBy as Record<string, unknown>)
      ?.name ??
    "linear-user";

  if (type === "Issue" && (action === "create" || action === "update")) {
    const title = (data.title as string) ?? "";
    const description = ((data.description as string) ?? "").slice(0, 2000);
    const url = (data.url as string) ?? "";
    const state =
      ((data.state as Record<string, unknown>)?.name as string) ?? "unknown";
    const priority = String(data.priority ?? "none");
    const labels = Array.isArray(data.labels)
      ? (data.labels as Array<Record<string, unknown>>)
          .map((l) => (l.name as string) ?? "")
          .filter(Boolean)
          .join(", ")
      : "";
    return (
      `Linear issue ${action} by ${actorName}: Title: ${title}\n` +
      `${description}\n` +
      `URL: ${url}\n` +
      `State: ${state}\n` +
      `Priority: ${priority}\n` +
      `Labels: ${labels}`
    );
  }

  if (type === "Comment" && action === "create") {
    const body = ((data.body as string) ?? "").slice(0, 2000);
    const url = (data.url as string) ?? "";
    const issue = data.issue as Record<string, unknown> | undefined;
    const issueTitle = (issue?.title as string) ?? "unknown";
    return (
      `Linear comment on issue '${issueTitle}' by ${actorName}:\n` +
      `${body}\n` +
      `URL: ${url}`
    );
  }

  if (type === "IssueLabel" && action === "create") {
    const label = data.label as Record<string, unknown> | undefined;
    const labelName = (label?.name as string) ?? "unknown";
    const issue = data.issue as Record<string, unknown> | undefined;
    const issueTitle = (issue?.title as string) ?? "unknown";
    const url = (issue?.url as string) ?? (data.url as string) ?? "";
    return (
      `Linear label '${labelName}' added to issue '${issueTitle}' by ${actorName}\n` +
      `URL: ${url}`
    );
  }

  return null;
}

// ── Label → Agent Routing ──────────────────────────────────────────

/**
 * Look up an agent ID from Linear labels via the linear_label_agent_mappings table.
 * Returns the first matching agent_id, or null if no mapping exists.
 */
export async function resolveAgentFromLabels(
  labels: string[],
  workspaceId?: string,
): Promise<string | null> {
  if (labels.length === 0) return null;
  const pool = getPool();
  const query = workspaceId
    ? `SELECT agent_id FROM linear_label_agent_mappings WHERE label_name = ANY($1) AND workspace_id = $2 LIMIT 1`
    : `SELECT agent_id FROM linear_label_agent_mappings WHERE label_name = ANY($1) LIMIT 1`;
  const params = workspaceId ? [labels, workspaceId] : [labels];
  const result = await pool.query(query, params);
  if (result.rows.length === 0) return null;
  return (result.rows[0] as Record<string, unknown>).agent_id as string;
}

// ── Deduplication ──────────────────────────────────────────────────

/**
 * Check if a Linear webhook delivery has already been processed.
 * Checks both exact delivery_id match and issue_id match (covers
 * cross-path dedup between webhook and heartbeat).
 */
export async function isAlreadyProcessed(
  deliveryId: string,
  issueId?: string,
): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    issueId
      ? `SELECT 1 FROM linear_webhook_events WHERE delivery_id = $1 OR issue_id = $2 LIMIT 1`
      : `SELECT 1 FROM linear_webhook_events WHERE delivery_id = $1 LIMIT 1`,
    issueId ? [deliveryId, issueId] : [deliveryId],
  );
  return result.rows.length > 0;
}

/**
 * Record a processed Linear webhook delivery for deduplication.
 */
export async function markProcessed(
  deliveryId: string,
  eventType: string,
  action: string,
  issueId: string | null,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO linear_webhook_events (delivery_id, event_type, action, issue_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [deliveryId, eventType, action, issueId],
  );
}

// ── Linear GraphQL API ─────────────────────────────────────────────

/**
 * Post a comment on a Linear issue via the GraphQL API.
 * Used by the adapter to send agent responses back to Linear.
 */
export async function postLinearComment(
  issueId: string,
  body: string,
  apiKey: string,
): Promise<void> {
  const query = `mutation CommentCreate($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
  }
}`;

  try {
    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables: { issueId, body } }),
    });

    if (!response.ok) {
      log.error(
        `Failed to post Linear comment: ${response.status} ${response.statusText}`,
      );
    }
  } catch (err) {
    log.error(
      "Error posting Linear comment:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ── Linear Channel Adapter ─────────────────────────────────────────
// Bidirectional: agent responses are posted back as comments on the
// Linear issue via the GraphQL API.

class LinearAdapter implements ChannelAdapter {
  readonly channelType = "linear" as const;
  private readonly _apiKey: string;

  constructor(apiKey: string) {
    this._apiKey = apiKey;
  }

  async sendMessage(chatId: string, message: OutgoingMessage): Promise<void> {
    // chatId is the Linear issue ID; post agent response as a comment
    await postLinearComment(chatId, message.text, this._apiKey);
  }

  async sendTypingIndicator(_chatId: string): Promise<void> {
    // Linear has no typing indicator concept.
  }

  async start(): Promise<void> {
    // Webhook registration is handled at the Express level in startLinearChannel.
  }

  async stop(): Promise<void> {
    // Express routes cannot be unregistered; lifecycle is managed externally.
  }
}

// ── Label Extraction Helpers ───────────────────────────────────────

/**
 * Extract label names from a Linear webhook payload based on event type.
 */
function extractLabels(
  type: LinearEventType,
  data: Record<string, unknown>,
): string[] {
  const labels: string[] = [];

  // For Issue events: data.labels is an array of { name: string }
  if (type === "Issue" && Array.isArray(data.labels)) {
    for (const label of data.labels as Array<Record<string, unknown>>) {
      const name = label.name as string | undefined;
      if (name) labels.push(name);
    }
  }

  // For IssueLabel events: the label is in data.label.name, plus check data.issue.labels
  if (type === "IssueLabel") {
    const label = data.label as Record<string, unknown> | undefined;
    const labelName = label?.name as string | undefined;
    if (labelName) labels.push(labelName);

    const issue = data.issue as Record<string, unknown> | undefined;
    if (issue && Array.isArray(issue.labels)) {
      for (const l of issue.labels as Array<Record<string, unknown>>) {
        const name = l.name as string | undefined;
        if (name && !labels.includes(name)) labels.push(name);
      }
    }
  }

  // For Comment events: check data.issue.labels if available
  if (type === "Comment") {
    const issue = data.issue as Record<string, unknown> | undefined;
    if (issue && Array.isArray(issue.labels)) {
      for (const l of issue.labels as Array<Record<string, unknown>>) {
        const name = l.name as string | undefined;
        if (name) labels.push(name);
      }
    }
  }

  return labels;
}

/**
 * Extract the issue ID from a Linear webhook payload based on event type.
 */
function extractIssueId(
  type: LinearEventType,
  data: Record<string, unknown>,
): string {
  if (type === "Issue") {
    return (data.id as string) ?? "";
  }
  // Comment and IssueLabel: issue ID is in data.issue.id or data.issueId
  const issue = data.issue as Record<string, unknown> | undefined;
  if (issue?.id) return issue.id as string;
  if (data.issueId) return data.issueId as string;
  return (data.id as string) ?? "";
}

// ── Lifecycle ──────────────────────────────────────────────────────

let _adapter: LinearAdapter | null = null;

/**
 * Register the Linear webhook handler on the Express app.
 * Route: POST /channels/linear/webhook
 */
export function startLinearChannel(
  config: LinearChannelConfig,
  resolveClient: ClientResolver,
  app: Express,
): void {
  _adapter = new LinearAdapter(config.apiKey);

  app.post(
    "/channels/linear/webhook",
    async (req: Request, res: Response) => {
      try {
        // The global express.json() middleware already parsed the body.
        // Use the raw buffer stashed by the verify callback for HMAC verification.
        const rawBody = (req as unknown as Record<string, unknown>).rawBody as Buffer | undefined;
        if (!rawBody) {
          res.status(400).json({ error: "Missing request body" });
          return;
        }
        const signature =
          (req.headers["linear-signature"] as string | undefined) ?? "";

        // 1. Verify HMAC-SHA256 signature
        if (!verifyLinearSignature(rawBody, config.webhookSecret, signature)) {
          log.warn("Linear webhook signature mismatch");
          res.status(401).json({ error: "Invalid signature" });
          return;
        }

        // 2. Body already parsed by express.json()
        const payload = req.body as Record<string, unknown>;

        // 3. Extract type, action, data
        const type = payload.type as string | undefined;
        const action = (payload.action as string) ?? "unknown";
        const data = payload.data as Record<string, unknown> | undefined;

        // 4. Filter unhandled event types
        if (!type || !HANDLED_EVENTS.includes(type as LinearEventType)) {
          res.status(200).json({ status: "ignored" });
          return;
        }

        if (!data) {
          res.status(200).json({ status: "ignored" });
          return;
        }

        const eventType = type as LinearEventType;

        // 5. Extract issue ID early (needed for dedup + routing)
        const issueId = extractIssueId(eventType, data);

        // 6. Compute synthetic delivery ID for deduplication
        const dataId = (data.id as string) ?? "";
        const updatedAt = (data.updatedAt as string) ?? "";
        const deliveryId = `${eventType}:${action}:${dataId}:${updatedAt}`;

        // 7. Check deduplication (also checks issue_id for cross-path dedup with heartbeat)
        if (await isAlreadyProcessed(deliveryId, issueId || undefined)) {
          res.status(200).json({ status: "duplicate" });
          return;
        }

        // 8. Build event text
        const text = buildLinearEventText(eventType, action, payload);
        if (!text) {
          res.status(200).json({ status: "ignored" });
          return;
        }

        // 9. Extract labels for agent routing
        const labels = extractLabels(eventType, data);

        // 10. Resolve agent from labels
        const agentId = await resolveAgentFromLabels(labels);
        if (agentId) {
          const { setChannelAgentMapping } = await import("./router.js");
          await setChannelAgentMapping("linear", issueId, agentId);
        }

        // 11. Build sender info
        const senderName =
          ((payload.actor as Record<string, unknown>)?.name as string) ??
          ((payload.createdBy as Record<string, unknown>)?.name as string) ??
          "linear-user";

        // 12. Build IncomingMessage
        const incoming: IncomingMessage = {
          channel: "linear",
          chatId: issueId,
          senderId: senderName,
          senderName,
          text,
          isGroup: false,
        };

        // 13. Mark processed
        await markProcessed(deliveryId, eventType, action, issueId || null);

        // 14. Route through shared handler
        await handleIncomingMessage(incoming, _adapter!, resolveClient);

        res.json({ status: "ok" });
      } catch (err) {
        log.error(
          "Error handling Linear webhook:",
          err instanceof Error ? err.message : String(err),
        );
        res.status(500).json({ error: "Internal error" });
      }
    },
  );

  log.active("Linear channel started");
}

/**
 * Stop the Linear channel.
 */
export function stopLinearChannel(): void {
  _adapter = null;
  log.dim("Linear channel stopped");
}
