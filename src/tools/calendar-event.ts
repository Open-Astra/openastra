import { z } from "zod";
import { registerTool } from "./registry.js";
import { getPool } from "../config/postgres.js";

// ── calendar_event ────────────────────────────────────────────────────
// Manage calendar events stored in Postgres. Supports creating, listing,
// and deleting events per user.

const CalendarEventParams = z.object({
  operation: z
    .enum(["create", "list", "delete"])
    .describe("Operation to perform: create, list, or delete an event"),
  title: z
    .string()
    .optional()
    .describe("Event title (required for create)"),
  description: z
    .string()
    .optional()
    .describe("Event description"),
  startTime: z
    .string()
    .optional()
    .describe("Start time as ISO 8601 string (required for create)"),
  endTime: z
    .string()
    .optional()
    .describe("End time as ISO 8601 string (required for create)"),
  eventId: z
    .string()
    .optional()
    .describe("Event ID (required for delete)"),
  daysAhead: z
    .number()
    .int()
    .min(1)
    .max(365)
    .default(7)
    .describe("Number of days ahead to list events (default 7, max 365)"),
});

let tableEnsured = false;

async function ensureTable(): Promise<void> {
  if (tableEnsured) return;

  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS calendar_events (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      uid           TEXT NOT NULL,
      title         TEXT NOT NULL,
      description   TEXT DEFAULT '',
      start_time    TIMESTAMPTZ NOT NULL,
      end_time      TIMESTAMPTZ NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Index for efficient per-user lookups by time range
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_calendar_events_uid_start
    ON calendar_events (uid, start_time)
  `);

  tableEnsured = true;
}

registerTool({
  name: "calendar_event",
  description:
    "Manage calendar events stored in the Astra database. Create events with a title, description, and time range. List upcoming events within a configurable number of days. Delete events by ID. Events are scoped per user.",
  parameters: CalendarEventParams,
  async execute(params, ctx) {
    try {
      await ensureTable();
      const pool = getPool();

      switch (params.operation) {
        case "create": {
          if (!params.title) {
            return { error: "title is required for create operation" };
          }
          if (!params.startTime) {
            return { error: "startTime is required for create operation" };
          }
          if (!params.endTime) {
            return { error: "endTime is required for create operation" };
          }

          // Validate date strings
          const start = new Date(params.startTime);
          const end = new Date(params.endTime);
          if (isNaN(start.getTime())) {
            return { error: "Invalid startTime — must be a valid ISO 8601 date string" };
          }
          if (isNaN(end.getTime())) {
            return { error: "Invalid endTime — must be a valid ISO 8601 date string" };
          }
          if (end <= start) {
            return { error: "endTime must be after startTime" };
          }

          const { rows } = await pool.query(
            `INSERT INTO calendar_events (uid, title, description, start_time, end_time)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, uid, title, description, start_time, end_time, created_at`,
            [ctx.uid, params.title, params.description ?? "", start.toISOString(), end.toISOString()],
          );

          return { event: rows[0] };
        }

        case "list": {
          const now = new Date();
          const until = new Date(now.getTime() + params.daysAhead * 24 * 60 * 60 * 1000);

          const { rows } = await pool.query(
            `SELECT id, title, description, start_time, end_time, created_at
             FROM calendar_events
             WHERE uid = $1 AND start_time >= $2 AND start_time <= $3
             ORDER BY start_time ASC
             LIMIT 100`,
            [ctx.uid, now.toISOString(), until.toISOString()],
          );

          return {
            events: rows,
            count: rows.length,
            range: { from: now.toISOString(), to: until.toISOString() },
          };
        }

        case "delete": {
          if (!params.eventId) {
            return { error: "eventId is required for delete operation" };
          }

          const { rowCount } = await pool.query(
            `DELETE FROM calendar_events WHERE id = $1 AND uid = $2`,
            [params.eventId, ctx.uid],
          );

          if (rowCount === 0) {
            return { error: "Event not found or does not belong to this user." };
          }

          return { deleted: true, eventId: params.eventId };
        }

        default:
          return { error: `Unknown operation: ${params.operation}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
  },
});
