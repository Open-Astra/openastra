// ── Consent Management Routes ─────────────────────────────────────────
// Mount: app.use("/security/consent", jwtAuth(), workspaceResolver(), createConsentRouter())
//
// GET    /security/consent       — list all consents for the caller
// POST   /security/consent       — record or update a consent decision
// DELETE /security/consent/:type — revoke a specific consent type

import { Router } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import {
  listConsents,
  recordConsent,
  revokeConsent,
} from "../../security/consent.js";

// ── Validation ────────────────────────────────────────────────────────

const RecordConsentBody = z.object({
  consentType: z.string().min(1).max(64),
  granted: z.boolean(),
  expiresAt: z.string().datetime().optional(),
});

// ── Helper ────────────────────────────────────────────────────────────

function resolveWorkspaceId(
  req: WorkspaceAwareRequest & AuthenticatedRequest,
): string {
  return req.workspace.workspaceId ?? req.uid;
}

// ── Router ────────────────────────────────────────────────────────────

export function createConsentRouter(): Router {
  const router = Router();

  // GET / — list all consent records for the authenticated user
  router.get("/", async (req, res) => {
    const r = req as unknown as WorkspaceAwareRequest & AuthenticatedRequest;
    const workspaceId = resolveWorkspaceId(r);

    try {
      const consents = await listConsents(workspaceId, r.uid);
      res.json({ consents });
    } catch (err) {
      console.error("[consent] GET error:", err);
      res.status(500).json({ error: "Failed to retrieve consents" });
    }
  });

  // POST / — record or update a consent decision
  router.post("/", async (req, res) => {
    const parsed = RecordConsentBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const r = req as unknown as WorkspaceAwareRequest & AuthenticatedRequest;
    const workspaceId = resolveWorkspaceId(r);
    const { consentType, granted, expiresAt } = parsed.data;

    try {
      const expiresDate = expiresAt ? new Date(expiresAt) : undefined;
      await recordConsent(workspaceId, r.uid, consentType, granted, expiresDate);
      const consents = await listConsents(workspaceId, r.uid);
      res.status(201).json({ recorded: true, consents });
    } catch (err) {
      console.error("[consent] POST error:", err);
      res.status(500).json({ error: "Failed to record consent" });
    }
  });

  // DELETE /:type — revoke a specific consent type
  router.delete("/:type", async (req, res) => {
    const r = req as unknown as WorkspaceAwareRequest & AuthenticatedRequest;
    const workspaceId = resolveWorkspaceId(r);
    const consentType = req.params.type;

    try {
      const deleted = await revokeConsent(workspaceId, r.uid, consentType);
      if (!deleted) {
        res.status(404).json({ error: "Consent record not found" });
        return;
      }
      res.json({ revoked: true, consentType });
    } catch (err) {
      console.error("[consent] DELETE error:", err);
      res.status(500).json({ error: "Failed to revoke consent" });
    }
  });

  return router;
}
