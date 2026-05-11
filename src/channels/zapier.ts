// ── Zapier Bridge ──────────────────────────────────────────────────
// Zapier REST Hooks bridge — receives trigger events from Zapier and
// forwards them as agent messages; also pushes agent events to Zapier
// hook URLs registered via the subscribe endpoint.
//
// Routes:
//  POST /zapier/trigger      — Zapier sends an event, route to agent
//  POST /zapier/subscribe    — Zapier registers a hook URL
//  DELETE /zapier/unsubscribe — Zapier removes a hook URL
//  GET /zapier/polling       — Zapier polling endpoint (last 10 events)
//
// Security: all outbound calls to hook_url go through SSRF guard.

import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { isBlockedUrl } from "../utils/ssrf-guard.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("zapier-bridge");

// ── In-memory event log for /polling ──────────────────────────────
// Stores the last 100 agent.completed events for Zapier polling.
interface PollingEvent {
  id: string;
  workspaceId: string;
  eventType: string;
  payload: unknown;
  timestamp: string;
}

const _pollingLog: PollingEvent[] = [];
const POLLING_LOG_MAX = 100;

function appendPollingEvent(workspaceId: string, eventType: string, payload: unknown): void {
  _pollingLog.push({
    id: randomUUID(),
    workspaceId,
    eventType,
    payload,
    timestamp: new Date().toISOString(),
  });
  if (_pollingLog.length > POLLING_LOG_MAX) {
    _pollingLog.splice(0, _pollingLog.length - POLLING_LOG_MAX);
  }
}

// ── Zod schemas ────────────────────────────────────────────────────

const SubscribeBody = z.object({
  hookUrl: z.string().url(),
  eventFilter: z.string().default("*"),
  createdBy: z.string().optional(),
  workspaceId: z.string(),
});

const UnsubscribeBody = z.object({
  hookUrl: z.string().url(),
  workspaceId: z.string(),
});

const TriggerBody = z.object({
  workspaceId: z.string(),
  eventType: z.string(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

// ── Notify Zapier subscribers ──────────────────────────────────────

/**
 * POST payload to all matching zapier_subscriptions for the given workspace
 * and event type. Filters by event_filter glob ('*' matches everything).
 * All outbound calls are SSRF-guarded.
 */
export async function notifyZapierSubscribers(
  workspaceId: string,
  eventType: string,
  payload: unknown,
): Promise<void> {
  const pool = getPool();
  let rows: Array<{ id: string; hook_url: string; event_filter: string }>;

  try {
    const result = await pool.query<{ id: string; hook_url: string; event_filter: string }>(
      `SELECT id, hook_url, event_filter FROM zapier_subscriptions WHERE workspace_id = $1`,
      [workspaceId],
    );
    rows = result.rows;
  } catch (err) {
    log.error("Failed to query zapier_subscriptions:", err instanceof Error ? err.message : String(err));
    return;
  }

  const matching = rows.filter((row) => {
    if (row.event_filter === "*") return true;
    // Simple glob: split by '*' and check all parts exist in order
    const parts = row.event_filter.split("*").filter(Boolean);
    let remaining = eventType;
    for (const part of parts) {
      const idx = remaining.indexOf(part);
      if (idx === -1) return false;
      remaining = remaining.slice(idx + part.length);
    }
    return true;
  });

  await Promise.allSettled(
    matching.map(async (sub) => {
      // SSRF guard before any outbound request
      if (await isBlockedUrl(sub.hook_url)) {
        log.warn(`SSRF blocked Zapier hook: ${sub.hook_url}`);
        return;
      }

      try {
        const response = await fetch(sub.hook_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ eventType, payload, timestamp: new Date().toISOString() }),
        });

        // Update last_triggered_at
        await pool.query(
          `UPDATE zapier_subscriptions SET last_triggered_at = NOW() WHERE id = $1`,
          [sub.id],
        );

        if (!response.ok) {
          log.warn(`Zapier hook ${sub.hook_url} responded ${response.status}`);
        }
      } catch (err) {
        log.error(`Failed to notify Zapier hook ${sub.hook_url}:`, err instanceof Error ? err.message : String(err));
      }
    }),
  );
}

// ── Event bus subscription ─────────────────────────────────────────

/**
 * Subscribe to agent.completed events and forward them to Zapier hooks.
 * Call once at startup (from gateway/index.ts or zapier router init).
 */

// ── Router ─────────────────────────────────────────────────────────

export function createZapierRouter(): Router {
  const router = Router();

  // POST /zapier/subscribe — Zapier registers a hook URL
  router.post("/subscribe", async (req: Request, res: Response) => {
    const parsed = SubscribeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.format() });
      return;
    }

    const { hookUrl, eventFilter, createdBy, workspaceId } = parsed.data;

    // SSRF guard before storing
    if (await isBlockedUrl(hookUrl)) {
      res.status(400).json({ error: "hookUrl targets a blocked internal address" });
      return;
    }

    const pool = getPool();
    try {
      const result = await pool.query<{ id: string; created_at: string }>(
        `INSERT INTO zapier_subscriptions (workspace_id, hook_url, event_filter, created_by)
         VALUES ($1, $2, $3, $4)
         RETURNING id, created_at`,
        [workspaceId, hookUrl, eventFilter, createdBy ?? null],
      );
      res.status(201).json({ subscriptionId: result.rows[0]!.id });
    } catch (err) {
      log.error("subscribe error:", err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: "Internal error" });
    }
  });

  // DELETE /zapier/unsubscribe — Zapier removes a hook URL
  router.delete("/unsubscribe", async (req: Request, res: Response) => {
    const parsed = UnsubscribeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.format() });
      return;
    }

    const { hookUrl, workspaceId } = parsed.data;
    const pool = getPool();
    try {
      const result = await pool.query(
        `DELETE FROM zapier_subscriptions WHERE hook_url = $1 AND workspace_id = $2`,
        [hookUrl, workspaceId],
      );
      res.json({ deleted: (result.rowCount ?? 0) > 0 });
    } catch (err) {
      log.error("unsubscribe error:", err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: "Internal error" });
    }
  });

  // POST /zapier/trigger — Zapier sends an event, we log it for polling
  router.post("/trigger", async (req: Request, res: Response) => {
    const parsed = TriggerBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.format() });
      return;
    }

    const { workspaceId, eventType, payload } = parsed.data;
    appendPollingEvent(workspaceId, eventType, payload ?? {});

    log.dim(`Zapier trigger received: ${eventType} for workspace ${workspaceId}`);
    res.json({ status: "ok", received: true });
  });

  // GET /zapier/polling — returns last 10 events for Zapier polling
  router.get("/polling", (req: Request, res: Response) => {
    const workspaceId = req.query["workspaceId"] as string | undefined;
    const eventType = req.query["eventType"] as string | undefined;

    let events = _pollingLog.slice();

    if (workspaceId) {
      events = events.filter((e) => e.workspaceId === workspaceId);
    }
    if (eventType) {
      events = events.filter((e) => e.eventType === eventType);
    }

    // Return newest-first, last 10
    res.json(events.reverse().slice(0, 10));
  });

  return router;
}
