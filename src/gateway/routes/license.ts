// ── License Status API ──────────────────────────────────────────────
// GET /admin/license — returns current license status.
// Protected by admin auth (same as other /admin routes).

import { Router } from "express";
import { getLicense, getFingerprint } from "../../licensing/index.js";

export function createLicenseRouter(): Router {
  const router = Router();

  // GET /admin/license — current license status
  router.get("/license", (_req, res) => {
    const license = getLicense();

    res.json({
      licensed: license.valid,
      tier: license.tier,
      customer: license.customerName ?? null,
      maxDevelopers: license.maxDevelopers,
      maxDeployments: license.maxDeployments,
      activeDevelopers: license.activeDevelopers,
      fingerprint: getFingerprint(),
      validatedAt: license.validatedAt.toISOString(),
      expiresAt: license.expiresAt?.toISOString() ?? null,
      graceMode: license.graceMode,
    });
  });

  return router;
}
