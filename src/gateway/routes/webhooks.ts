import { Router } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import {
  createWebhook,
  listWebhooks,
  getWebhook,
  updateWebhook,
  deleteWebhook,
  getDeliveries,
} from "../../webhooks/store.js";
import { dispatchWebhook } from "../../webhooks/dispatcher.js";
import { CreateWebhookBody, UpdateWebhookBody } from "../../webhooks/types.js";

// ── Webhook REST Router ─────────────────────────────────────────────

export function createWebhookRouter(): Router {
  const router = Router();

  // POST /webhooks — register a new webhook
  router.post("/", async (req, res) => {
    const { uid } = req as unknown as AuthenticatedRequest;
    const parsed = CreateWebhookBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    try {
      const webhook = await createWebhook(uid, parsed.data.url, parsed.data.events, parsed.data.description);
      res.status(201).json(webhook);
    } catch (err) {
      console.error("[webhooks] Create error:", err);
      res.status(500).json({ error: "Failed to create webhook" });
    }
  });

  // GET /webhooks — list all webhooks
  router.get("/", async (req, res) => {
    const { uid } = req as unknown as AuthenticatedRequest;
    try {
      const webhooks = await listWebhooks(uid);
      // Omit secrets from list response
      const safe = webhooks.map(({ secret: _s, ...rest }) => rest);
      res.json({ webhooks: safe });
    } catch (err) {
      console.error("[webhooks] List error:", err);
      res.status(500).json({ error: "Failed to list webhooks" });
    }
  });

  // GET /webhooks/:id — get a single webhook
  router.get("/:id", async (req, res) => {
    const { uid } = req as unknown as AuthenticatedRequest;
    try {
      const webhook = await getWebhook(uid, req.params.id);
      if (!webhook) {
        res.status(404).json({ error: "Webhook not found" });
        return;
      }
      const { secret: _s, ...safe } = webhook;
      res.json(safe);
    } catch (err) {
      console.error("[webhooks] Get error:", err);
      res.status(500).json({ error: "Failed to get webhook" });
    }
  });

  // PUT /webhooks/:id — update a webhook
  router.put("/:id", async (req, res) => {
    const { uid } = req as unknown as AuthenticatedRequest;
    const parsed = UpdateWebhookBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    try {
      const updated = await updateWebhook(uid, req.params.id, parsed.data);
      if (!updated) {
        res.status(404).json({ error: "Webhook not found" });
        return;
      }
      res.json(updated);
    } catch (err) {
      console.error("[webhooks] Update error:", err);
      res.status(500).json({ error: "Failed to update webhook" });
    }
  });

  // DELETE /webhooks/:id — delete a webhook
  router.delete("/:id", async (req, res) => {
    const { uid } = req as unknown as AuthenticatedRequest;
    try {
      const deleted = await deleteWebhook(uid, req.params.id);
      if (!deleted) {
        res.status(404).json({ error: "Webhook not found" });
        return;
      }
      res.json({ deleted: true });
    } catch (err) {
      console.error("[webhooks] Delete error:", err);
      res.status(500).json({ error: "Failed to delete webhook" });
    }
  });

  // GET /webhooks/:id/deliveries — recent delivery history
  router.get("/:id/deliveries", async (req, res) => {
    const { uid } = req as unknown as AuthenticatedRequest;
    try {
      const deliveries = await getDeliveries(uid, req.params.id);
      res.json({ deliveries });
    } catch (err) {
      console.error("[webhooks] Deliveries error:", err);
      res.status(500).json({ error: "Failed to get deliveries" });
    }
  });

  // POST /webhooks/:id/test — send a test webhook
  router.post("/:id/test", async (req, res) => {
    const { uid } = req as unknown as AuthenticatedRequest;
    try {
      const webhook = await getWebhook(uid, req.params.id);
      if (!webhook) {
        res.status(404).json({ error: "Webhook not found" });
        return;
      }

      const delivery = await dispatchWebhook(webhook, {
        event: "agent_completed",
        timestamp: Date.now(),
        data: { test: true, message: "This is a test webhook from Astra." },
      });

      res.json({ delivery });
    } catch (err) {
      console.error("[webhooks] Test error:", err);
      res.status(500).json({ error: "Failed to send test webhook" });
    }
  });

  return router;
}
