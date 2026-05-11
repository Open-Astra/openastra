import { createHmac, randomUUID } from "node:crypto";
import type { WebhookDoc, WebhookPayload, WebhookDelivery, WebhookEventType } from "./types.js";
import { getWebhooksForEvent, logDelivery } from "./store.js";
import { checkWebhookRate } from "./rate-limiter.js";
import { getEventBus } from "../events/index.js";
import { isBlockedUrl } from "../utils/ssrf-guard.js";
import { logWebhookDispatch } from "./inspector-log.js";
import { interceptWebhookIfTestMode } from "./test-mode.js";

// ── Constants ───────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 4000, 16000]; // exponential backoff
const TIMEOUT_MS = 10_000;

// ── HMAC Signing ────────────────────────────────────────────────────

function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

// ── Dispatch a Single Webhook ───────────────────────────────────────

export async function dispatchWebhook(
  webhook: WebhookDoc,
  payload: WebhookPayload,
): Promise<WebhookDelivery> {
  // If test mode is enabled, intercept and return synthetic delivery
  const testDelivery = interceptWebhookIfTestMode(webhook, payload);
  if (testDelivery) return testDelivery;

  const deliveryId = randomUUID();
  const body = JSON.stringify(payload);
  const signature = signPayload(body, webhook.secret);
  const startTime = Date.now();

  let lastError: string | undefined;
  let statusCode: number | undefined;
  let responseBody: string | undefined;
  let attempts = 0;

  for (let i = 0; i <= MAX_RETRIES; i++) {
    attempts++;
    try {
      if (i > 0) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[i - 1]));
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      if (await isBlockedUrl(webhook.url)) {
        throw new Error("Webhook URL targets a blocked internal address");
      }

      const res = await fetch(webhook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Signature": signature,
          "X-Webhook-Id": webhook.id,
          "X-Delivery-Id": deliveryId,
          "User-Agent": "Astra-Webhooks/1.0",
        },
        body,
        signal: controller.signal,
        redirect: "manual",
      });

      // Block redirect-based SSRF: if the server redirected, reject it
      if (res.status >= 300 && res.status < 400) {
        throw new Error("Webhook endpoint returned a redirect, which is not allowed");
      }

      clearTimeout(timeout);
      statusCode = res.status;
      responseBody = await res.text().catch(() => undefined);

      if (res.ok) {
        const delivery: WebhookDelivery = {
          id: deliveryId,
          webhookId: webhook.id,
          eventType: payload.event,
          payload: payload as unknown as Record<string, unknown>,
          statusCode,
          responseBody: responseBody?.slice(0, 500),
          success: true,
          attempts,
          durationMs: Date.now() - startTime,
          timestamp: Date.now(),
        };

        logDelivery(webhook.uid, webhook.id, delivery).catch(() => {});
        logWebhookDispatch({
          workspaceId: webhook.uid,
          webhookUrl: webhook.url,
          eventType: payload.event,
          payload: payload as unknown as Record<string, unknown>,
          responseStatus: statusCode,
          responseBody: responseBody?.slice(0, 500),
          durationMs: delivery.durationMs,
        });
        return delivery;
      }

      lastError = `HTTP ${statusCode}`;

      // Don't retry on 4xx (client errors — likely permanent)
      if (statusCode >= 400 && statusCode < 500) break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  const delivery: WebhookDelivery = {
    id: deliveryId,
    webhookId: webhook.id,
    eventType: payload.event,
    payload: payload as unknown as Record<string, unknown>,
    statusCode,
    responseBody: responseBody?.slice(0, 500),
    success: false,
    attempts,
    durationMs: Date.now() - startTime,
    error: lastError,
    timestamp: Date.now(),
  };

  logDelivery(webhook.uid, webhook.id, delivery).catch(() => {});
  logWebhookDispatch({
    workspaceId: webhook.uid,
    webhookUrl: webhook.url,
    eventType: payload.event,
    payload: payload as unknown as Record<string, unknown>,
    responseStatus: statusCode,
    responseBody: responseBody?.slice(0, 500),
    durationMs: delivery.durationMs,
  });
  return delivery;
}

// ── Fire Webhooks for Event ─────────────────────────────────────────

export async function fireWebhooksForEvent(
  uid: string,
  event: WebhookEventType,
  data: Record<string, unknown>,
): Promise<void> {
  if (!checkWebhookRate(uid)) {
    console.warn(`[webhooks] Rate limit exceeded for uid=${uid}`);
    return;
  }

  const webhooks = await getWebhooksForEvent(uid, event);
  if (webhooks.length === 0) return;

  const payload: WebhookPayload = {
    event,
    timestamp: Date.now(),
    data,
  };

  const results = await Promise.allSettled(
    webhooks.map((wh) => dispatchWebhook(wh, payload)),
  );

  const bus = getEventBus();
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    const webhook = webhooks[i]!;

    bus.emit("webhook.dispatched", {
      uid,
      webhookId: webhook.id,
      eventType: event,
      statusCode: result.status === "fulfilled" ? result.value.statusCode : undefined,
      success: result.status === "fulfilled" ? result.value.success : false,
      timestamp: Date.now(),
    });
  }
}
