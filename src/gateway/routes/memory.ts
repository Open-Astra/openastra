import { Router } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { getPool } from "../../config/postgres.js";
import {
  loadProfile,
  updateProfile,
  loadRecentDailyMemory,
} from "../../memory/store.js";
import { indexProfile, indexDailyMemory } from "../../memory/indexer.js";
import { searchMemory } from "../../memory/search.js";
import type { DailyMemoryDoc } from "../../memory/types.js";

// ── Request Validation ──────────────────────────────────────────────

const UpdateProfileBody = z.object({
  displayName: z.string().optional(),
  timezone: z.string().optional(),
  locale: z.string().optional(),
  communicationStyle: z.enum(["concise", "detailed", "casual", "formal"]).optional(),
  strategicNotes: z.array(z.string()).optional(),
  interests: z.array(z.string()).optional(),
  expertiseAreas: z.array(z.string()).optional(),
  notificationPreferences: z
    .object({
      enabled: z.boolean(),
      channels: z.array(z.string()).optional(),
      quietHoursStart: z.number().int().min(0).max(23).optional(),
      quietHoursEnd: z.number().int().min(0).max(23).optional(),
    })
    .optional(),
  domains: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

const AddNoteBody = z.object({
  note: z.string().min(1).max(5000),
});

const DateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const SearchQuery = z.object({
  q: z.string().min(1),
  topK: z.coerce.number().int().min(1).max(50).default(5),
});

// ── Memory Router Factory ───────────────────────────────────────────

export function createMemoryRouter(): Router {
  const router = Router();

  // ── Profile (Long-term memory) ──────────────────────────────────

  // GET /memory/profile
  router.get("/memory/profile", async (req, res) => {
    const { uid } = req as AuthenticatedRequest;

    try {
      const profile = await loadProfile(uid);
      res.json({ profile: profile ?? null });
    } catch (err) {
      console.error("[memory] Failed to load profile:", err);
      res.status(500).json({ error: "Failed to load profile" });
    }
  });

  // PUT /memory/profile
  router.put("/memory/profile", async (req, res) => {
    const { uid } = req as AuthenticatedRequest;

    const parsed = UpdateProfileBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    try {
      await updateProfile(uid, parsed.data);
      const updated = await loadProfile(uid);

      if (updated) {
        await indexProfile(uid, updated);
      }

      res.json({ profile: updated });
    } catch (err) {
      console.error("[memory] Failed to update profile:", err);
      res.status(500).json({ error: "Failed to update profile" });
    }
  });

  // ── Daily Memory ────────────────────────────────────────────────

  // GET /memory/daily
  router.get("/memory/daily", async (req, res) => {
    const { uid } = req as AuthenticatedRequest;

    try {
      const docs = await loadRecentDailyMemory(uid);
      res.json({ daily: docs });
    } catch (err) {
      console.error("[memory] Failed to load daily memory:", err);
      res.status(500).json({ error: "Failed to load daily memory" });
    }
  });

  // GET /memory/daily/:date
  router.get("/memory/daily/:date", async (req, res) => {
    const { uid } = req as unknown as AuthenticatedRequest;
    const { date } = req.params;

    const dateParsed = DateParam.safeParse(date);
    if (!dateParsed.success) {
      res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD." });
      return;
    }

    try {
      const pool = getPool();
      const { rows } = await pool.query<{ entries: unknown[]; updated_at: string }>(
        "SELECT entries, updated_at FROM daily_memory WHERE user_id = $1 AND date = $2",
        [uid, date],
      );

      if (rows.length === 0) {
        res.status(404).json({ error: "No daily memory found for this date" });
        return;
      }

      const doc: DailyMemoryDoc = {
        date,
        entries: rows[0]!.entries as DailyMemoryDoc["entries"],
        updatedAt: new Date(rows[0]!.updated_at).getTime(),
      };
      res.json({ daily: doc });
    } catch (err) {
      console.error("[memory] Failed to load daily memory for date:", err);
      res.status(500).json({ error: "Failed to load daily memory" });
    }
  });

  // DELETE /memory/daily/:date/:entryIndex
  router.delete("/memory/daily/:date/:entryIndex", async (req, res) => {
    const { uid } = req as unknown as AuthenticatedRequest;
    const { date, entryIndex: entryIndexStr } = req.params;

    const dateParsed = DateParam.safeParse(date);
    if (!dateParsed.success) {
      res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD." });
      return;
    }

    const entryIndex = parseInt(entryIndexStr, 10);
    if (isNaN(entryIndex) || entryIndex < 0) {
      res.status(400).json({ error: "Invalid entry index" });
      return;
    }

    try {
      const pool = getPool();
      const { rows } = await pool.query<{ entries: unknown[]; updated_at: string }>(
        "SELECT entries, updated_at FROM daily_memory WHERE user_id = $1 AND date = $2",
        [uid, date],
      );

      if (rows.length === 0) {
        res.status(404).json({ error: "No daily memory found for this date" });
        return;
      }

      const entries = rows[0]!.entries as DailyMemoryDoc["entries"];

      if (entryIndex >= entries.length) {
        res.status(404).json({ error: "Entry index out of range" });
        return;
      }

      entries.splice(entryIndex, 1);
      const now = Date.now();

      await pool.query(
        "UPDATE daily_memory SET entries = $1::jsonb, updated_at = NOW() WHERE user_id = $2 AND date = $3",
        [JSON.stringify(entries), uid, date],
      );

      const doc: DailyMemoryDoc = { date, entries, updatedAt: now };
      await indexDailyMemory(uid, doc);

      res.status(204).send();
    } catch (err) {
      console.error("[memory] Failed to delete daily entry:", err);
      res.status(500).json({ error: "Failed to delete daily entry" });
    }
  });

  // ── Strategic Notes ─────────────────────────────────────────────

  // POST /memory/notes
  router.post("/memory/notes", async (req, res) => {
    const { uid } = req as AuthenticatedRequest;

    const parsed = AddNoteBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    try {
      const profile = await loadProfile(uid);
      const notes = profile?.strategicNotes ?? [];
      notes.push(parsed.data.note);

      await updateProfile(uid, { strategicNotes: notes });
      const updated = await loadProfile(uid);

      if (updated) {
        await indexProfile(uid, updated);
      }

      res.json({ profile: updated });
    } catch (err) {
      console.error("[memory] Failed to add strategic note:", err);
      res.status(500).json({ error: "Failed to add strategic note" });
    }
  });

  // DELETE /memory/notes/:index
  router.delete("/memory/notes/:index", async (req, res) => {
    const { uid } = req as unknown as AuthenticatedRequest;
    const { index: indexStr } = req.params;

    const index = parseInt(indexStr, 10);
    if (isNaN(index) || index < 0) {
      res.status(400).json({ error: "Invalid note index" });
      return;
    }

    try {
      const profile = await loadProfile(uid);
      if (!profile) {
        res.status(404).json({ error: "No profile found" });
        return;
      }

      if (index >= profile.strategicNotes.length) {
        res.status(404).json({ error: "Note index out of range" });
        return;
      }

      profile.strategicNotes.splice(index, 1);
      await updateProfile(uid, { strategicNotes: profile.strategicNotes });

      const updated = await loadProfile(uid);
      if (updated) {
        await indexProfile(uid, updated);
      }

      res.status(204).send();
    } catch (err) {
      console.error("[memory] Failed to delete strategic note:", err);
      res.status(500).json({ error: "Failed to delete strategic note" });
    }
  });

  // ── Search ──────────────────────────────────────────────────────

  // GET /memory/search?q=query&topK=5
  router.get("/memory/search", async (req, res) => {
    const { uid } = req as AuthenticatedRequest;

    const parsed = SearchQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid search query", details: parsed.error.format() });
      return;
    }

    const { q, topK } = parsed.data;

    try {
      const results = await searchMemory(uid, q, topK);
      res.json({ results });
    } catch (err) {
      console.error("[memory] Search failed:", err);
      res.status(500).json({ error: "Memory search failed" });
    }
  });

  return router;
}
