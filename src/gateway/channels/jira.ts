// ── Jira Channel Router ──────────────────────────────────────────────
// Receives Jira webhook events (issue created/updated, comment added, etc.)
// and dispatches them to the appropriate agent.
// Uses its own HMAC-SHA256 verification against JIRA_WEBHOOK_SECRET.

import { Router, type Request, type Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("jira-channel");

function verifyJiraSignature(req: Request): boolean {
  const secret = process.env.JIRA_WEBHOOK_SECRET;
  if (!secret) return true; // not configured — skip verification

  const signature = req.headers["x-hub-signature"] as string | undefined;
  if (!signature) return false;

  const rawBody = (req as unknown as Record<string, unknown>).rawBody as Buffer | undefined;
  if (!rawBody) return false;

  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

export function createJiraRouter(): Router {
  const router = Router();

  // POST /jira/webhook — receive Jira webhook events
  router.post("/webhook", (req: Request, res: Response) => {
    if (!verifyJiraSignature(req)) {
      res.status(401).json({ error: "invalid signature" });
      return;
    }

    const { webhookEvent, issue } = req.body as { webhookEvent?: string; issue?: Record<string, unknown> };
    if (!webhookEvent) {
      res.status(400).json({ error: "webhookEvent is required" });
      return;
    }

    log.dim("Jira webhook received", webhookEvent, issue?.key ?? "");
    // TODO: route to agent loop based on workspace Jira config
    res.json({ received: true, event: webhookEvent });
  });

  // GET /jira/test — verify Jira webhook connectivity
  router.get("/test", (_req, res) => {
    res.json({ ok: true, channel: "jira" });
  });

  return router;
}
