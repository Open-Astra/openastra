import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { hashPassword, verifyPassword } from "../../auth/passwords.js";
import {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  revokeToken,
  revokeAllAccessTokens,
  decodeTokenUnsafe,
} from "../../auth/jwt.js";
import {
  createUser,
  findUserByEmail,
  storeRefreshToken,
  revokeRefreshToken,
  isRefreshTokenValid,
  isRefreshTokenRevoked,
  revokeAllUserTokens,
  getTokenFamily,
  revokeTokenFamily,
} from "../../auth/store.js";
import { bruteForceProtection, recordFailedAttempt, recordSuccessfulAttempt, getClientIp } from "../middleware/brute-force.js";
import { jwtAuth, requestFingerprint } from "../middleware/auth.js";
import { isPlatformAdmin } from "../middleware/platform-admin.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { getEventBus } from "../../events/index.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("auth-routes");

// ── Request Validation ──────────────────────────────────────────────

const RegisterBody = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  displayName: z.string().max(100).optional(),
});

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string(),
});

const RefreshBody = z.object({
  refreshToken: z.string(),
});

// Revocation targets:
//   { token }          — an access token the caller holds (must be their own)
//   { all: true }      — every access + refresh token of the caller
//   { jti } / { uid }  — arbitrary token / user; platform admin key only
const RevokeBody = z.object({
  token: z.string().min(1).max(4096).optional(),
  all: z.boolean().optional(),
  jti: z.string().min(1).max(256).optional(),
  uid: z.string().min(1).max(256).optional(),
}).refine((b) => [b.token, b.all, b.jti, b.uid].filter(Boolean).length === 1, {
  message: "Provide exactly one of: token, all, jti, uid",
});

// ── Registration throttle ───────────────────────────────────────────
// Registration is unauthenticated, so it is limited per client IP.
// REGISTRATION_ENABLED=false turns self-service signup off entirely
// (accounts are then created by the operator).

const REGISTER_WINDOW_MS = 60 * 60 * 1000;
const REGISTER_MAX = Math.max(1, parseInt(process.env.REGISTRATION_RATE_LIMIT_PER_HOUR ?? "5", 10) || 5);
const registerAttempts = new Map<string, number[]>();

const registerCleanup = setInterval(() => {
  const cutoff = Date.now() - REGISTER_WINDOW_MS;
  for (const [ip, stamps] of registerAttempts) {
    const live = stamps.filter((t) => t > cutoff);
    if (live.length === 0) registerAttempts.delete(ip);
    else registerAttempts.set(ip, live);
  }
}, 10 * 60_000);
registerCleanup.unref();

function allowRegistration(ip: string): boolean {
  const now = Date.now();
  const live = (registerAttempts.get(ip) ?? []).filter((t) => t > now - REGISTER_WINDOW_MS);
  if (live.length >= REGISTER_MAX) {
    registerAttempts.set(ip, live);
    return false;
  }
  live.push(now);
  registerAttempts.set(ip, live);
  return true;
}

// Compared against when the email is unknown so login takes the same time
// whether or not the account exists. Generated lazily (same bcrypt cost as
// real hashes) from a random value that can never match.
let dummyHash: Promise<string> | undefined;
function getDummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomUUID());
  return dummyHash;
}

// ── Auth Router ─────────────────────────────────────────────────────

export function createAuthRouter(): Router {
  const router = Router();

  // POST /auth/register
  router.post("/register", async (req: Request, res: Response) => {
    if (process.env.REGISTRATION_ENABLED === "false") {
      res.status(403).json({ error: "Self-service registration is disabled" });
      return;
    }

    if (!allowRegistration(getClientIp(req))) {
      res.setHeader("Retry-After", String(Math.ceil(REGISTER_WINDOW_MS / 1000)));
      res.status(429).json({ error: "Too many registration attempts. Please try again later." });
      return;
    }

    const parsed = RegisterBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const { email, password, displayName } = parsed.data;

    try {
      const existing = await findUserByEmail(email);
      if (existing) {
        res.status(409).json({ error: "Email already registered" });
        return;
      }

      const hash = await hashPassword(password);
      const user = await createUser(email, hash, displayName);

      const accessToken = await signAccessToken(user.id, requestFingerprint(req));
      const refreshToken = await signRefreshToken(user.id);
      await storeRefreshToken(user.id, refreshToken);

      res.status(201).json({
        user: { id: user.id, email: user.email, displayName: user.displayName },
        accessToken,
        refreshToken,
      });
    } catch (err) {
      log.error("Register error:", err);
      res.status(500).json({ error: "Registration failed" });
    }
  });

  // POST /auth/login — protected by brute-force middleware
  router.post("/login", bruteForceProtection(), async (req: Request, res: Response) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const { email, password } = parsed.data;
    const ip = getClientIp(req);

    try {
      const user = await findUserByEmail(email);
      if (!user) {
        // Burn the same bcrypt time as a real check so response timing
        // does not reveal whether the email is registered.
        await verifyPassword(password, await getDummyPasswordHash()).catch(() => false);
        // Record failure but return generic message
        await recordFailedAttempt(ip);
        res.status(401).json({ error: "Invalid credentials" });
        return;
      }

      const valid = await verifyPassword(password, user.passwordHash);
      if (!valid) {
        await recordFailedAttempt(ip);
        res.status(401).json({ error: "Invalid credentials" });
        return;
      }

      // Successful login — clear brute-force counter
      await recordSuccessfulAttempt(ip);

      const accessToken = await signAccessToken(user.id, requestFingerprint(req));
      const refreshToken = await signRefreshToken(user.id);
      await storeRefreshToken(user.id, refreshToken);

      res.json({
        user: { id: user.id, email: user.email, displayName: user.displayName },
        accessToken,
        refreshToken,
      });
    } catch (err) {
      log.error("Login error:", err);
      res.status(500).json({ error: "Login failed" });
    }
  });

  // POST /auth/refresh — with replay detection
  router.post("/refresh", async (req: Request, res: Response) => {
    const parsed = RefreshBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }

    const { refreshToken } = parsed.data;

    try {
      // Verify the JWT signature and enforce type === "refresh"
      const { uid } = await verifyRefreshToken(refreshToken);

      // ── Replay Detection ──────────────────────────────────────
      // If the token exists but is already revoked, this is a replay attack.
      // Revoke the entire token family and emit a critical security event.
      const alreadyRevoked = await isRefreshTokenRevoked(refreshToken);
      if (alreadyRevoked) {
        log.warn(`Refresh token replay detected for uid=${uid}`);

        // Revoke the entire token family
        const family = await getTokenFamily(refreshToken);
        if (family) {
          await revokeTokenFamily(family);
        }

        // Also revoke all refresh tokens for this user as a safety measure
        await revokeAllUserTokens(uid);

        // Revoke all access tokens for the user
        await revokeAllAccessTokens(uid);

        // Emit critical security event
        const bus = getEventBus();
        bus.emit("security.token_replay", {
          uid,
          tokenFamily: family ?? undefined,
          ip: getClientIp(req),
          severity: "critical" as const,
          timestamp: Date.now(),
        });

        res.status(401).json({ error: "Token reuse detected. All sessions have been revoked." });
        return;
      }

      // Check if the token is still valid in the database
      const valid = await isRefreshTokenValid(refreshToken);
      if (!valid) {
        res.status(401).json({ error: "Invalid or revoked refresh token" });
        return;
      }

      // Get the token family before revoking
      const family = await getTokenFamily(refreshToken);

      // Rotate: revoke old, issue new (in the same family)
      await revokeRefreshToken(refreshToken);

      const newAccessToken = await signAccessToken(uid, requestFingerprint(req));
      const newRefreshToken = await signRefreshToken(uid);
      await storeRefreshToken(uid, newRefreshToken, family ?? undefined);

      res.json({
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
      });
    } catch {
      res.status(401).json({ error: "Invalid or expired refresh token" });
    }
  });

  // POST /auth/logout — revokes all refresh tokens + access tokens for the user
  router.post("/logout", async (req: Request, res: Response) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing authorization" });
      return;
    }

    try {
      const { uid } = await verifyAccessToken(authHeader.slice(7), requestFingerprint(req));

      // Revoke all refresh tokens
      await revokeAllUserTokens(uid);

      // Revoke all access tokens via sentinel
      await revokeAllAccessTokens(uid);

      res.json({ message: "Logged out" });
    } catch {
      res.status(401).json({ error: "Invalid token" });
    }
  });

  // POST /auth/revoke — revoke access tokens.
  // A user may revoke a token they hold, or all of their own tokens.
  // Revoking someone else's token (by jti or uid) is a platform-admin
  // operation: it requires the INTERNAL_API_KEY in X-Api-Key. Workspace
  // ownership grants no authority over other users' sessions.
  router.post("/revoke", jwtAuth(), async (req: Request, res: Response) => {
    const parsed = RevokeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const callerUid = (req as AuthenticatedRequest).uid;
    const { token, all, jti, uid: targetUid } = parsed.data;
    const bus = getEventBus();

    try {
      // 1. All of the caller's own tokens
      if (all) {
        await revokeAllUserTokens(callerUid);
        await revokeAllAccessTokens(callerUid);
        bus.emit("security.token_revoked", {
          uid: callerUid, jti: `all:${callerUid}`, revokedBy: callerUid, timestamp: Date.now(),
        });
        res.json({ message: "All tokens revoked" });
        return;
      }

      // 2. A specific token the caller holds — must verify and be their own
      if (token) {
        let owner: string;
        try {
          ({ uid: owner } = await verifyAccessToken(token, requestFingerprint(req)));
        } catch {
          // Already invalid/expired/revoked — nothing left to revoke
          res.json({ message: "Token revoked" });
          return;
        }
        if (owner !== callerUid) {
          res.status(403).json({ error: "You can only revoke your own tokens" });
          return;
        }
        const claims = decodeTokenUnsafe(token);
        if (!claims.jti) {
          res.status(400).json({ error: "Token has no jti claim" });
          return;
        }
        const exp = claims.exp ? new Date(claims.exp * 1000) : new Date(Date.now() + 24 * 60 * 60 * 1000);
        await revokeToken(claims.jti, exp, callerUid);
        bus.emit("security.token_revoked", {
          uid: callerUid, jti: claims.jti, revokedBy: callerUid, timestamp: Date.now(),
        });
        res.json({ message: "Token revoked", jti: claims.jti });
        return;
      }

      // 3. Arbitrary jti / uid — platform admin only
      if (!isPlatformAdmin(req)) {
        res.status(403).json({ error: "Revoking another user's tokens requires the platform admin key" });
        return;
      }

      if (targetUid) {
        await revokeAllUserTokens(targetUid);
        await revokeAllAccessTokens(targetUid);
        bus.emit("security.token_revoked", {
          uid: targetUid, jti: `all:${targetUid}`, revokedBy: callerUid, timestamp: Date.now(),
        });
        res.json({ message: "All tokens revoked", uid: targetUid });
        return;
      }

      // Raw jti. The "all:<uid>" sentinel namespace is reserved for the
      // bulk-revocation paths above.
      if (!jti || jti.startsWith("all:")) {
        res.status(400).json({ error: "Invalid jti" });
        return;
      }
      const exp = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await revokeToken(jti, exp);
      bus.emit("security.token_revoked", {
        uid: callerUid, jti, revokedBy: callerUid, timestamp: Date.now(),
      });
      res.json({ message: "Token revoked", jti });
    } catch (err) {
      log.error("Token revocation error:", err);
      res.status(500).json({ error: "Revocation failed" });
    }
  });

  return router;
}
