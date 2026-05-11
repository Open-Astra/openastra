// ── Webhook Testing Mode ────────────────────────────────────────────
// Intercepts webhook dispatches and stores them in memory instead of
// sending real HTTP requests. Useful for integration testing and
// development without needing real webhook endpoints.

import type { WebhookDoc, WebhookPayload, WebhookDelivery, WebhookEventType } from "./types.js";
import { randomUUID } from "node:crypto";

// ── Types ───────────────────────────────────────────────────────────

export interface TestWebhookEntry {
  id: string;
  webhookId: string;
  webhookUrl: string;
  eventType: WebhookEventType;
  payload: WebhookPayload;
  interceptedAt: number;
}

// ── State ───────────────────────────────────────────────────────────

let testModeEnabled = false;
const testWebhookLog: TestWebhookEntry[] = [];

// ── Public API ──────────────────────────────────────────────────────

export function enableWebhookTestMode(): void {
  testModeEnabled = true;
}

export function disableWebhookTestMode(): void {
  testModeEnabled = false;
}

export function isWebhookTestModeEnabled(): boolean {
  return testModeEnabled;
}

export function getTestWebhookLog(): TestWebhookEntry[] {
  return [...testWebhookLog];
}

export function clearTestWebhookLog(): void {
  testWebhookLog.length = 0;
}

// ── Interceptor ─────────────────────────────────────────────────────
// Called by the dispatcher before sending a real webhook. If test mode
// is on, records the dispatch and returns a synthetic delivery. If
// test mode is off, returns null to signal the caller to proceed
// normally.

export function interceptWebhookIfTestMode(
  webhook: WebhookDoc,
  payload: WebhookPayload,
): WebhookDelivery | null {
  if (!testModeEnabled) return null;

  const entry: TestWebhookEntry = {
    id: randomUUID(),
    webhookId: webhook.id,
    webhookUrl: webhook.url,
    eventType: payload.event,
    payload,
    interceptedAt: Date.now(),
  };

  testWebhookLog.push(entry);

  // Return a synthetic successful delivery
  return {
    id: entry.id,
    webhookId: webhook.id,
    eventType: payload.event,
    payload: payload as unknown as Record<string, unknown>,
    statusCode: 200,
    responseBody: '{"test_mode": true}',
    success: true,
    attempts: 1,
    durationMs: 0,
    timestamp: Date.now(),
  };
}
