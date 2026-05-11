import type { Request, Response, NextFunction } from "express";
import { verifyAccessToken, computeFingerprint } from "../../auth/jwt.js";

// ── JWT Auth Middleware ─────────────────────────────────────────────
// Validates the JWT access token from the Authorization header.
// Attaches the decoded uid to req for downstream handlers.

export interface AuthenticatedRequest extends Request {
  uid: string;
}

export function jwtAuth() {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing or invalid Authorization header" });
      return;
    }

    const token = authHeader.slice(7);

    try {
      // Compute device fingerprint when binding is enabled
      let fingerprint: string | undefined;
      if (process.env.BIND_JWT_TO_DEVICE === "true") {
        const ua = req.headers["user-agent"] ?? "";
        const ip = req.ip ?? req.socket.remoteAddress ?? "";
        fingerprint = computeFingerprint(ua, ip);
      }
      const { uid } = await verifyAccessToken(token, fingerprint);
      (req as AuthenticatedRequest).uid = uid;
      next();
    } catch {
      res.status(401).json({ error: "Invalid or expired token" });
    }
  };
}

// Keep the old name as an alias for backward compatibility in route wiring
export const firebaseAuth = jwtAuth;
