import { timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import { getFailoverPool } from "../../config/postgres-failover.js";

// ── Internal API Key Auth (same pattern as admin.ts) ─────────────────

function internalApiKey() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const expected = process.env.INTERNAL_API_KEY;

    if (!expected) {
      res.status(500).json({ error: "Server misconfigured — internal API key not set" });
      return;
    }

    const provided = req.headers["x-api-key"];
    const providedStr = Array.isArray(provided) ? provided[0] : provided;
    if (!providedStr) {
      res.status(401).json({ error: "Invalid or missing API key" });
      return;
    }

    let isValid = false;
    try {
      isValid = timingSafeEqual(Buffer.from(providedStr), Buffer.from(expected));
    } catch {
      isValid = false;
    }

    if (!isValid) {
      res.status(401).json({ error: "Invalid or missing API key" });
      return;
    }

    next();
  };
}

// ── Failover Router ───────────────────────────────────────────────────

export function createFailoverRouter(): Router {
  const router = Router();

  // GET /admin/failover/status — current DB region + failover timestamp
  router.get("/admin/failover/status", internalApiKey(), (_req: Request, res: Response) => {
    const status = getFailoverPool().getStatus();
    res.json(status);
  });

  // POST /admin/failover/trigger — manually failover to standby
  router.post("/admin/failover/trigger", internalApiKey(), async (_req: Request, res: Response) => {
    try {
      await getFailoverPool().failover();
      res.json({ message: "Failover to standby completed", region: "standby" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // POST /admin/failover/recover — recover back to primary
  router.post("/admin/failover/recover", internalApiKey(), async (_req: Request, res: Response) => {
    try {
      await getFailoverPool().recover();
      res.json({ message: "Recovered to primary DB", region: "primary" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  return router;
}
