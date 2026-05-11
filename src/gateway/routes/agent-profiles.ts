import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { jwtAuth } from "../middleware/auth.js";
import { workspaceResolver } from "../middleware/workspace.js";
import type { ProfileReport } from "../../agents/perf-profiler.js";

// ── Agent Profiles Router ─────────────────────────────────────────────
// Exposes in-memory profiler reports for agent sessions.
// Reports are stored in a ring-buffer (max 100 per session).

const RING_BUFFER_SIZE = 100;

// In-memory store: sessionId → ring buffer of ProfileReport
const _profileStore = new Map<string, ProfileReport[]>();

/**
 * Save a profiler report for a session.
 * Ring-buffer: oldest entry is dropped when the buffer is full.
 */
export function saveProfileReport(sessionId: string, report: ProfileReport): void {
  const existing = _profileStore.get(sessionId) ?? [];
  if (existing.length >= RING_BUFFER_SIZE) {
    existing.shift(); // drop oldest
  }
  existing.push(report);
  _profileStore.set(sessionId, existing);
}

/**
 * Retrieve all stored profile reports for a session.
 */
export function getProfileReports(sessionId: string): ProfileReport[] {
  return _profileStore.get(sessionId) ?? [];
}

// ── Query schema ─────────────────────────────────────────────────────

const ProfilesQuery = z.object({
  sessionId: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// ── Router ────────────────────────────────────────────────────────────

export function createAgentProfilesRouter(): Router {
  const router = Router();
  router.use(jwtAuth(), workspaceResolver());

  // GET /agent-profiles?sessionId=xxx&limit=20
  router.get("/", (req: Request, res: Response) => {
    const parsed = ProfilesQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.format() });
      return;
    }

    const { sessionId, limit } = parsed.data;
    const all = getProfileReports(sessionId);

    // Return the N most recent
    const reports = all.slice(-limit);

    res.json({
      sessionId,
      reports,
      total: all.length,
    });
  });

  return router;
}
