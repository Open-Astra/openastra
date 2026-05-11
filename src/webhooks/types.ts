import { z } from "zod";

// ── Webhook Event Types ─────────────────────────────────────────────

export const WebhookEventType = z.enum([
  "agent_completed",
  "agent_error",
  "line_alert",
  "briefing_ready",
  "budget_soft_cap",
  "budget_hard_cap",
  "memory_updated",
]);
export type WebhookEventType = z.infer<typeof WebhookEventType>;

// ── Webhook Document ────────────────────────────────────────────────
// Stored at users/{uid}/webhooks/{id}

export interface WebhookDoc {
  id: string;
  uid: string;
  url: string;
  events: WebhookEventType[];
  secret: string; // 32-byte hex for HMAC-SHA256 signing
  active: boolean;
  createdAt: number;
  updatedAt: number;
  description?: string;
}

// ── Webhook Delivery Log ────────────────────────────────────────────
// Stored at users/{uid}/webhooks/{webhookId}/deliveries/{deliveryId}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  eventType: WebhookEventType;
  payload: Record<string, unknown>;
  statusCode?: number;
  responseBody?: string;
  success: boolean;
  attempts: number;
  durationMs: number;
  error?: string;
  timestamp: number;
}

// ── Webhook Payload ─────────────────────────────────────────────────

export interface WebhookPayload {
  event: WebhookEventType;
  timestamp: number;
  data: Record<string, unknown>;
}

// ── API Schemas ─────────────────────────────────────────────────────

export const CreateWebhookBody = z.object({
  url: z.string().url(),
  events: z.array(WebhookEventType).min(1),
  description: z.string().max(200).optional(),
});

export const UpdateWebhookBody = z.object({
  url: z.string().url().optional(),
  events: z.array(WebhookEventType).min(1).optional(),
  active: z.boolean().optional(),
  description: z.string().max(200).optional(),
});
