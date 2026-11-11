import { Router, type Request, type Response } from "express";
import {
  enableWebhookTestMode,
  disableWebhookTestMode,
  getTestWebhookLog,
  clearTestWebhookLog,
  isWebhookTestModeEnabled,
} from "../../webhooks/test-mode.js";
import { platformAdmin } from "../middleware/platform-admin.js";

// ── Webhook Testing Router ─────────────────────────────────────────
// POST /webhooks/test-mode/enable   — enable test mode
// POST /webhooks/test-mode/disable  — disable test mode
// GET  /webhooks/test-mode/log      — get intercepted webhooks
// DELETE /webhooks/test-mode/log    — clear intercepted webhooks

export function createWebhookTestingRouter(): Router {
  const router = Router();

  // Test mode is a process-wide switch: it intercepts EVERY tenant's
  // webhook deliveries and the log holds their payloads. Operator only.
  router.use("/test-mode", platformAdmin());

  // POST /webhooks/test-mode/enable
  router.post("/test-mode/enable", (_req: Request, res: Response) => {
    enableWebhookTestMode();
    res.json({ enabled: true, message: "Webhook test mode enabled. Dispatches will be intercepted." });
  });

  // POST /webhooks/test-mode/disable
  router.post("/test-mode/disable", (_req: Request, res: Response) => {
    disableWebhookTestMode();
    res.json({ enabled: false, message: "Webhook test mode disabled. Dispatches will be sent normally." });
  });

  // GET /webhooks/test-mode/log
  router.get("/test-mode/log", (_req: Request, res: Response) => {
    const log = getTestWebhookLog();
    res.json({
      testModeEnabled: isWebhookTestModeEnabled(),
      count: log.length,
      entries: log,
    });
  });

  // DELETE /webhooks/test-mode/log
  router.delete("/test-mode/log", (_req: Request, res: Response) => {
    clearTestWebhookLog();
    res.json({ cleared: true });
  });

  return router;
}
