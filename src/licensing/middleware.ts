// ── License Middleware ───────────────────────────────────────────────
// Attaches license info to requests and tracks developer activations.
// Does NOT hard-block requests — unlicensed installs still work
// (XenForo-style: the software runs, but the license status is tracked).

import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../gateway/middleware/auth.js";
import { getLicense, trackActivation } from "./index.js";
import type { LicenseInfo } from "./index.js";

export interface LicenseAwareRequest extends AuthenticatedRequest {
  license?: LicenseInfo;
  licenseOverSeatLimit?: boolean;
}

/**
 * License middleware — runs after jwtAuth().
 * Attaches license info to the request and tracks developer activations.
 * Non-blocking: unlicensed requests pass through with license.valid = false.
 */
export function licenseGuard() {
  return async (
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const license = getLicense();
    (req as LicenseAwareRequest).license = license;

    // Track developer activation if licensed and authenticated
    const uid = (req as AuthenticatedRequest).uid;
    if (uid && license.valid && process.env.ASTRA_LICENSE_KEY) {
      try {
        const activeDevs = await trackActivation(
          process.env.ASTRA_LICENSE_KEY,
          uid,
        );
        license.activeDevelopers = activeDevs;

        if (activeDevs > license.maxDevelopers) {
          (req as LicenseAwareRequest).licenseOverSeatLimit = true;
        }
      } catch {
        // Activation tracking failure is non-fatal
      }
    }

    next();
  };
}
