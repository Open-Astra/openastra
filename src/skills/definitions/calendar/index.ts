import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── Calendar Skill ──────────────────────────────────────────────────
// Provides agents with date/time awareness and scheduling utilities.
// Registers get-current-datetime, parse-date-expression, and a stub
// add-calendar-event tool. Injects current date + formatting guidance
// into the system prompt via getPromptContext().

const AddCalendarEventParams = z.object({
  title: z.string().describe("Event title"),
  date: z
    .string()
    .describe("ISO 8601 date string (YYYY-MM-DD or full ISO timestamp)"),
  duration: z
    .number()
    .int()
    .min(1)
    .max(1440)
    .optional()
    .default(60)
    .describe("Event duration in minutes (default 60)"),
  description: z.string().optional().describe("Event description"),
  timezone: z
    .string()
    .optional()
    .describe("IANA timezone string. Defaults to UTC."),
});

const calendarSkill: SkillDefinition = {
  name: "calendar",
  version: "1.0.0",

  manifest: {
    id: "calendar",
    name: "Calendar & Date Awareness",
    description:
      "Provides agents with real-time date/time awareness, natural-language date parsing, " +
      "and basic calendar event scheduling. Injects current date context into the system prompt.",
    category: "execute",
    tools: ["get-current-datetime", "parse-date-expression", "add-calendar-event"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    // The get-current-datetime and parse-date-expression tools are registered
    // via src/tools/index.ts. Here we register the stub add-calendar-event
    // tool that is part of this skill's manifest.
    ctx.registerTool({
      name: "add-calendar-event",
      description:
        "Stub calendar event creation. Creates a reminder entry for the agent. " +
        "For full calendar integration, connect a Google Calendar or Outlook skill.",
      parameters: AddCalendarEventParams,
      async execute(params, _ctx) {
        // Parse and validate the date
        const eventDate = new Date(params.date);
        if (isNaN(eventDate.getTime())) {
          return { error: `Invalid date: "${params.date}". Use ISO 8601 format.` };
        }

        const endDate = new Date(eventDate.getTime() + (params.duration ?? 60) * 60 * 1000);

        return {
          stub: true,
          message:
            "Event noted. This is a stub implementation — no external calendar was modified. " +
            "To persist events, use the calendar_event tool with the Astra database or connect a calendar provider.",
          event: {
            title: params.title,
            description: params.description ?? "",
            startTime: eventDate.toISOString(),
            endTime: endDate.toISOString(),
            timezone: params.timezone ?? "UTC",
            durationMinutes: params.duration ?? 60,
          },
        };
      },
    });
  },

  getPromptContext() {
    const now = new Date();
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const monthNames = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ];

    const dayOfWeek = dayNames[now.getUTCDay()]!;
    const month = monthNames[now.getUTCMonth()]!;
    const day = now.getUTCDate();
    const year = now.getUTCFullYear();
    const timeStr = now.toISOString().slice(11, 19); // HH:MM:SS UTC

    return {
      skillId: "calendar",
      instructions: [
        `## Date & Time Awareness`,
        `Current date/time (UTC): ${dayOfWeek}, ${month} ${day}, ${year} at ${timeStr} UTC`,
        `ISO timestamp: ${now.toISOString()}`,
        ``,
        `You have access to the following calendar tools:`,
        `- **get-current-datetime**: Returns the current date/time in ISO, human-readable, or Unix format, with timezone support.`,
        `- **parse-date-expression**: Converts natural language date expressions ("next Monday", "in 3 days", "end of month") into ISO dates.`,
        `- **add-calendar-event**: Creates a calendar event stub (use calendar_event tool for persistent storage).`,
        ``,
        `When users reference dates, always clarify the timezone if ambiguous. Use parse-date-expression for relative date phrases.`,
        `Format dates as YYYY-MM-DD in your responses unless the user specifies otherwise.`,
        `Upcoming event reminders should include day of week for clarity (e.g., "Tuesday, March 12, 2026").`,
      ].join("\n"),
    };
  },
};

export default calendarSkill;
