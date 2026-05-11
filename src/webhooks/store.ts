import { randomUUID, randomBytes } from "node:crypto";
import { URL } from "node:url";
import { getPool } from "../config/postgres.js";
import type { WebhookDoc, WebhookDelivery, WebhookEventType } from "./types.js";

// ── SSRF Prevention ─────────────────────────────────────────────────
// Block webhook URLs that target private networks, loopback, link-local,
// cloud metadata endpoints, and non-HTTP(S) schemes.

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.goog",
]);

const PRIVATE_IP_RANGES = [
  /^127\./,                      // loopback
  /^10\./,                       // RFC-1918
  /^172\.(1[6-9]|2\d|3[01])\./, // RFC-1918
  /^192\.168\./,                 // RFC-1918
  /^169\.254\./,                 // link-local / AWS metadata
  /^::1$/,                       // IPv6 loopback
  /^fc[0-9a-f]{2}:/i,            // IPv6 unique-local
  /^fe80:/i,                     // IPv6 link-local
];

function validateWebhookUrl(urlStr: string): void {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error("Invalid webhook URL: must be a valid URL");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Invalid webhook URL: only http:// and https:// schemes are allowed");
  }

  const host = parsed.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new Error("Invalid webhook URL: target host is not allowed");
  }

  if (PRIVATE_IP_RANGES.some((r) => r.test(host))) {
    throw new Error("Invalid webhook URL: private and reserved IP ranges are not allowed");
  }
}

// ── CRUD ────────────────────────────────────────────────────────────

export async function createWebhook(
  uid: string,
  url: string,
  events: WebhookEventType[],
  description?: string,
): Promise<WebhookDoc> {
  validateWebhookUrl(url);
  const pool = getPool();
  const id = randomUUID();
  const secret = randomBytes(32).toString("hex");
  const now = Date.now();

  await pool.query(
    `INSERT INTO webhooks (id, user_id, url, events, secret, description)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, uid, url, events, secret, description ?? null],
  );

  return {
    id,
    uid,
    url,
    events,
    secret,
    active: true,
    createdAt: now,
    updatedAt: now,
    description,
  };
}

export async function listWebhooks(uid: string): Promise<WebhookDoc[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, user_id, url, events, secret, active, description,
            created_at, updated_at
     FROM webhooks WHERE user_id = $1 ORDER BY created_at DESC`,
    [uid],
  );

  return rows.map(rowToWebhook);
}

export async function getWebhook(uid: string, webhookId: string): Promise<WebhookDoc | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    "SELECT * FROM webhooks WHERE id = $1 AND user_id = $2",
    [webhookId, uid],
  );
  return rows.length > 0 ? rowToWebhook(rows[0]) : null;
}

export async function updateWebhook(
  uid: string,
  webhookId: string,
  updates: Partial<Pick<WebhookDoc, "url" | "events" | "active" | "description">>,
): Promise<WebhookDoc | null> {
  const pool = getPool();

  const setClauses: string[] = ["updated_at = NOW()"];
  const values: unknown[] = [];
  let idx = 1;

  if (updates.url !== undefined) {
    validateWebhookUrl(updates.url);
    setClauses.push(`url = $${idx++}`);
    values.push(updates.url);
  }
  if (updates.events !== undefined) {
    setClauses.push(`events = $${idx++}`);
    values.push(updates.events);
  }
  if (updates.active !== undefined) {
    setClauses.push(`active = $${idx++}`);
    values.push(updates.active);
  }
  if (updates.description !== undefined) {
    setClauses.push(`description = $${idx++}`);
    values.push(updates.description);
  }

  values.push(webhookId, uid);

  const { rows } = await pool.query(
    `UPDATE webhooks SET ${setClauses.join(", ")}
     WHERE id = $${idx++} AND user_id = $${idx}
     RETURNING *`,
    values,
  );

  return rows.length > 0 ? rowToWebhook(rows[0]) : null;
}

export async function deleteWebhook(uid: string, webhookId: string): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    "DELETE FROM webhooks WHERE id = $1 AND user_id = $2",
    [webhookId, uid],
  );
  return (rowCount ?? 0) > 0;
}

// ── Query Webhooks for Event ────────────────────────────────────────

export async function getWebhooksForEvent(
  uid: string,
  event: WebhookEventType,
): Promise<WebhookDoc[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM webhooks
     WHERE user_id = $1 AND active = true AND $2 = ANY(events)`,
    [uid, event],
  );

  return rows.map(rowToWebhook);
}

// ── Delivery Logging ────────────────────────────────────────────────

export async function logDelivery(
  _uid: string,
  _webhookId: string,
  delivery: WebhookDelivery,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO webhook_deliveries
       (id, webhook_id, event_type, payload, status_code, response_body,
        success, attempts, duration_ms, error, timestamp)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11)`,
    [
      delivery.id,
      delivery.webhookId,
      delivery.eventType,
      JSON.stringify(delivery.payload),
      delivery.statusCode ?? null,
      delivery.responseBody ?? null,
      delivery.success,
      delivery.attempts,
      delivery.durationMs,
      delivery.error ?? null,
      delivery.timestamp,
    ],
  );
}

export async function getDeliveries(
  uid: string,
  webhookId: string,
  limit = 20,
): Promise<WebhookDelivery[]> {
  const pool = getPool();

  // Verify the requesting user owns this webhook before returning deliveries
  const { rows: ownerCheck } = await pool.query(
    "SELECT 1 FROM webhooks WHERE id = $1 AND user_id = $2",
    [webhookId, uid],
  );
  if (ownerCheck.length === 0) {
    return [];
  }

  const { rows } = await pool.query<{
    id: string;
    webhook_id: string;
    event_type: string;
    payload: Record<string, unknown>;
    status_code: number | null;
    response_body: string | null;
    success: boolean;
    attempts: number;
    duration_ms: number;
    error: string | null;
    timestamp: string;
  }>(
    `SELECT * FROM webhook_deliveries
     WHERE webhook_id = $1 ORDER BY timestamp DESC LIMIT $2`,
    [webhookId, limit],
  );

  return rows.map((r) => ({
    id: r.id,
    webhookId: r.webhook_id,
    eventType: r.event_type as WebhookEventType,
    payload: r.payload,
    statusCode: r.status_code ?? undefined,
    responseBody: r.response_body ?? undefined,
    success: r.success,
    attempts: r.attempts,
    durationMs: r.duration_ms,
    error: r.error ?? undefined,
    timestamp: parseInt(String(r.timestamp), 10),
  }));
}

// ── Row Mapper ──────────────────────────────────────────────────────

function rowToWebhook(row: Record<string, unknown>): WebhookDoc {
  return {
    id: row.id as string,
    uid: row.user_id as string,
    url: row.url as string,
    events: row.events as WebhookEventType[],
    secret: row.secret as string,
    active: row.active as boolean,
    createdAt: new Date(row.created_at as string).getTime(),
    updatedAt: new Date(row.updated_at as string).getTime(),
    description: (row.description as string) ?? undefined,
  };
}
