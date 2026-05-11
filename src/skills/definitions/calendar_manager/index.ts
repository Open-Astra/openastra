import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── Calendar Manager Skill ──────────────────────────────────────────
// Manage calendar events via Google Calendar API or compatible.
// Requires CALENDAR_API_KEY and CALENDAR_ID.

const ListEventsParams = z.object({
  days: z.number().int().min(1).max(30).default(7).describe("Number of days ahead to look"),
  maxResults: z.number().int().min(1).max(50).default(10),
});

const CreateEventParams = z.object({
  summary: z.string().describe("Event title"),
  description: z.string().optional().describe("Event description"),
  startTime: z.string().describe("Start time (ISO 8601)"),
  endTime: z.string().describe("End time (ISO 8601)"),
  location: z.string().optional(),
});

const calendarManagerSkill: SkillDefinition = {
  name: "calendar_manager",
  version: "1.0.0",

  manifest: {
    id: "calendar_manager",
    name: "Calendar Manager",
    description: "List, create, and manage calendar events via Google Calendar API.",
    category: "execute",
    tools: ["calendar_list", "calendar_create"],
    configFields: [
      { name: "apiKey", type: "string", required: true, description: "Google Calendar API key", envVar: "CALENDAR_API_KEY" },
      { name: "calendarId", type: "string", required: false, description: "Calendar ID", envVar: "CALENDAR_ID" },
    ],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    const getConfig = () => ({
      apiKey: process.env.CALENDAR_API_KEY ?? "",
      calendarId: process.env.CALENDAR_ID ?? "primary",
    });

    ctx.registerTool({
      name: "calendar_list",
      description: "List upcoming calendar events.",
      parameters: ListEventsParams,

      async execute(params) {
        const { apiKey, calendarId } = getConfig();
        if (!apiKey) return { error: "CALENDAR_API_KEY not configured." };

        const now = new Date();
        const end = new Date(now.getTime() + params.days * 86_400_000);

        const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?key=${apiKey}&timeMin=${now.toISOString()}&timeMax=${end.toISOString()}&maxResults=${params.maxResults}&singleEvents=true&orderBy=startTime`;

        const res = await safeFetch(url, { ssrfProtection: false });
        if (!res.ok) return { error: `Calendar API error ${res.status}` };

        const data = (await res.json()) as { items?: Array<{ id: string; summary: string; start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string }; location?: string; description?: string }> };

        return {
          count: data.items?.length ?? 0,
          events: (data.items ?? []).map((e) => ({
            id: e.id,
            summary: e.summary,
            start: e.start.dateTime ?? e.start.date,
            end: e.end.dateTime ?? e.end.date,
            location: e.location,
            description: e.description?.slice(0, 200),
          })),
        };
      },
    });

    ctx.registerTool({
      name: "calendar_create",
      description: "Create a new calendar event.",
      parameters: CreateEventParams,

      async execute(params) {
        const { apiKey, calendarId } = getConfig();
        if (!apiKey) return { error: "CALENDAR_API_KEY not configured." };

        const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?key=${apiKey}`;

        const res = await safeFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            summary: params.summary,
            description: params.description,
            start: { dateTime: params.startTime },
            end: { dateTime: params.endTime },
            location: params.location,
          }),
          ssrfProtection: false,
        });

        if (!res.ok) {
          const err = await res.text();
          return { error: `Calendar API error ${res.status}: ${err.slice(0, 300)}` };
        }

        const data = (await res.json()) as { id: string; htmlLink: string };
        return { success: true, eventId: data.id, link: data.htmlLink };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "calendar_manager",
      instructions: "You can manage calendar events with `calendar_list` (upcoming events) and `calendar_create` (new event). Requires CALENDAR_API_KEY.",
    };
  },
};

export default calendarManagerSkill;
