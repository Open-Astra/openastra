// ── Zapier Channel Router ────────────────────────────────────────────
// Receives Zapier webhook triggers and dispatches them to the appropriate agent.
// Authentication is handled via jwtAuth() middleware mounted in gateway/index.ts.

import { Router } from "express";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("zapier-channel");

export function createZapierRouter(): Router {
  const router = Router();

  // POST /zapier/trigger — receive a Zapier zap trigger payload
  router.post("/trigger", (req, res) => {
    const { event } = req.body as { event?: string; data?: unknown };
    if (!event) {
      res.status(400).json({ error: "event is required" });
      return;
    }
    log.dim("Zapier trigger received", event);
    // TODO: route to agent loop based on workspace agent config
    res.json({ received: true, event });
  });

  // GET /zapier/test — verify Zapier webhook connectivity
  router.get("/test", (_req, res) => {
    res.json({ ok: true, channel: "zapier" });
  });

  return router;
}
