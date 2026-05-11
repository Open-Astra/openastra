import { z } from "zod";
import { registerTool } from "./registry.js";

// ── get-current-datetime ─────────────────────────────────────────────
// Returns the current date and time in multiple formats with optional
// timezone support.

const Params = z.object({
  timezone: z
    .string()
    .optional()
    .describe("IANA timezone string (e.g. 'America/New_York', 'UTC'). Defaults to UTC."),
  format: z
    .enum(["iso", "human", "unix"])
    .optional()
    .default("iso")
    .describe("Output format: 'iso' for ISO 8601, 'human' for readable string, 'unix' for epoch seconds."),
});

registerTool({
  name: "get-current-datetime",
  description:
    "Returns the current date and time in ISO 8601, human-readable, and Unix timestamp formats. " +
    "Supports IANA timezone strings (e.g. 'America/New_York', 'Europe/London', 'UTC'). " +
    "Use this to give agents real-time date and time awareness.",
  parameters: Params,
  async execute(params) {
    const tz = params.timezone ?? "UTC";
    const now = new Date();

    let human: string;
    try {
      human = now.toLocaleString("en-US", {
        timeZone: tz,
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
        timeZoneName: "short",
      });
    } catch {
      return { error: `Invalid timezone: "${tz}". Use a valid IANA timezone string.` };
    }

    const iso = now.toISOString();
    const unix = Math.floor(now.getTime() / 1000);

    // Determine day of week in target timezone
    const dayOfWeek = now.toLocaleDateString("en-US", {
      timeZone: tz,
      weekday: "long",
    });

    // Determine local date string in target timezone
    const localDate = now.toLocaleDateString("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });

    return {
      iso,
      human,
      unix,
      timezone: tz,
      dayOfWeek,
      localDate,
      utcOffset: Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" })
        .formatToParts(now)
        .find((p) => p.type === "timeZoneName")
        ?.value ?? "UTC",
    };
  },
});
