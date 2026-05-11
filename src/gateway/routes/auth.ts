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
import { jwtAuth } from "../middleware/auth.js";
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

const RevokeBody = z.object({
  jti: z.string().min(1),
});

// ── Auth Router ─────────────────────────────────────────────────────

export function createAuthRouter(): Router {
  const router = Router();

  // POST /auth/register
  router.post("/register", async (req: Request, res: Response) => {
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

      const accessToken = await signAccessToken(user.id);
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

      const accessToken = await signAccessToken(user.id);
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

      const newAccessToken = await signAccessToken(uid);
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
      const { uid } = await verifyAccessToken(authHeader.slice(7));

      // Revoke all refresh tokens
      await revokeAllUserTokens(uid);

      // Revoke all access tokens via sentinel
      await revokeAllAccessTokens(uid);

      res.json({ message: "Logged out" });
    } catch {
      res.status(401).json({ error: "Invalid token" });
    }
  });

  // POST /auth/revoke — revoke a specific access token by JTI (admin only)
  router.post("/revoke", jwtAuth(), async (req: Request, res: Response) => {
    const parsed = RevokeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const { jti } = parsed.data;
    const adminUid = (req as AuthenticatedRequest).uid;

    // Admin role check — only workspace owners can revoke arbitrary tokens.
    // Regular users can only revoke their own tokens (jti must start with their uid sentinel).
    try {
      const pool = (await import("../../config/postgres.js")).getPool();
      const { rows } = await pool.query(
        `SELECT 1 FROM workspace_members WHERE user_id = $1 AND role = 'owner' LIMIT 1`,
        [adminUid],
      );
      const isOwner = rows.length > 0;

      // Non-owners can only revoke tokens they own — check revoked_tokens or
      // only allow revoking their own sentinel (all:<uid>)
      if (!isOwner) {
        // Check if the JTI belongs to a token the user owns
        const tokenCheck = await pool.query(
          `SELECT uid FROM revoked_tokens WHERE jti = $1`,
          [jti],
        );
        // If JTI is not yet revoked, we can't verify ownership — deny for non-owners
        if (tokenCheck.rows.length === 0 && !jti.startsWith(`all:${adminUid}`)) {
          res.status(403).json({ error: "Only workspace owners can revoke arbitrary tokens" });
          return;
        }
      }
    } catch {
      // If workspace_members check fails, deny by default (fail-closed)
      res.status(403).json({ error: "Unable to verify admin status" });
      return;
    }

    try {
      // Default expiration: 24 hours from now (covers max access token lifetime)
      const exp = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await revokeToken(jti, exp, adminUid);

      // Emit security event
      const bus = getEventBus();
      bus.emit("security.token_revoked", {
        uid: adminUid,
        jti,
        revokedBy: adminUid,
        timestamp: Date.now(),
      });

      res.json({ message: "Token revoked", jti });
    } catch (err) {
      log.error("Token revocation error:", err);
      res.status(500).json({ error: "Revocation failed" });
    }
  });

  return router;
}
