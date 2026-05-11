// ── GDPR Data Deletion Endpoint ──────────────────────────────────────
// DELETE /memory/user/:uid — purges ALL memory tiers for a user.
// Phase 4.4 of security audit.

import { Router } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("gdpr");

export function createGdprRouter(): Router {
  const router = Router();

  // DELETE /memory/user/:uid — Purge all memory for a user (GDPR right to erasure)
  router.delete("/memory/user/:uid", async (req, res) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const targetUid = req.params.uid;

    // Users can only delete their own data (unless we add admin role check later)
    if (authReq.uid !== targetUid) {
      res.status(403).json({ error: "You can only delete your own data" });
      return;
    }

    try {
      const { eraseUserData } = await import("../../security/gdpr-erasure.js");
      const result = await eraseUserData(targetUid, (req as any).workspace?.workspaceId ?? "default");
      log.info(`GDPR erasure completed for uid=${targetUid}: ${JSON.stringify(result.counts)}`);
      res.json({ purged: true, counts: result.counts, deletedAt: result.deletedAt });
    } catch (err) {
      log.error(`GDPR purge failed for uid=${targetUid}:`, err);
      res.status(500).json({ error: "Failed to purge user data" });
    }
  });

  return router;
}
