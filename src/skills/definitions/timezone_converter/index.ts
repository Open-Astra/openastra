import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── Timezone Converter Skill ─────────────────────────────────────
// Converts times between IANA timezones using Node.js built-in
// Intl.DateTimeFormat. No external API required.

const TimezoneConverterParams = z.object({
  time: z
    .string()
    .describe('Time to convert — ISO 8601 string (e.g. "2024-06-15T14:30:00") or "now" for current time'),
  fromTimezone: z
    .string()
    .describe('Source IANA timezone (e.g. "America/New_York", "Europe/London", "Asia/Tokyo")'),
  toTimezone: z
    .string()
    .describe('Target IANA timezone (e.g. "America/Los_Angeles", "Europe/Berlin", "Asia/Shanghai")'),
});

function getTimezoneOffset(date: Date, timezone: string): number {
  // Get the UTC offset in minutes for a given timezone at a specific time
  const utcStr = date.toLocaleString("en-US", { timeZone: "UTC" });
  const tzStr = date.toLocaleString("en-US", { timeZone: timezone });
  const utcDate = new Date(utcStr);
  const tzDate = new Date(tzStr);
  return (tzDate.getTime() - utcDate.getTime()) / 60_000;
}

function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  return `UTC${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function formatDateTime(date: Date, timezone: string): string {
  return date.toLocaleString("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  });
}

function formatIso(date: Date, timezone: string): string {
  // Build an ISO-ish string in the target timezone
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .formatToParts(date)
    .reduce(
      (acc, part) => {
        acc[part.type] = part.value;
        return acc;
      },
      {} as Record<string, string>,
    );

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const timezoneConverterSkill: SkillDefinition = {
  name: "timezone_converter",
  version: "1.0.0",

  manifest: {
    id: "timezone_converter",
    name: "Timezone Converter",
    description:
      "Converts times between IANA timezones using Node.js built-in Intl.DateTimeFormat. No external API required.",
    category: "transform",
    tools: ["timezone_converter"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "timezone_converter",
      description:
        'Convert a time from one IANA timezone to another. Use "now" for current time or provide an ISO 8601 string.',
      parameters: TimezoneConverterParams,

      async execute(params) {
        const { time, fromTimezone, toTimezone } = params;

        // Validate timezones
        if (!isValidTimezone(fromTimezone)) {
          return { error: `Invalid source timezone: "${fromTimezone}". Use IANA format (e.g. "America/New_York").` };
        }
        if (!isValidTimezone(toTimezone)) {
          return { error: `Invalid target timezone: "${toTimezone}". Use IANA format (e.g. "Europe/London").` };
        }

        // Parse the input time
        let date: Date;
        if (time.toLowerCase() === "now") {
          date = new Date();
        } else {
          date = new Date(time);
          if (isNaN(date.getTime())) {
            return { error: `Invalid time format: "${time}". Use ISO 8601 (e.g. "2024-06-15T14:30:00") or "now".` };
          }
        }

        // Calculate offsets
        const fromOffset = getTimezoneOffset(date, fromTimezone);
        const toOffset = getTimezoneOffset(date, toTimezone);
        const diffMinutes = toOffset - fromOffset;
        const diffHours = diffMinutes / 60;

        return {
          original: {
            time: formatIso(date, fromTimezone),
            timezone: fromTimezone,
            offset: formatOffset(fromOffset),
            formatted: formatDateTime(date, fromTimezone),
          },
          converted: {
            time: formatIso(date, toTimezone),
            timezone: toTimezone,
            offset: formatOffset(toOffset),
            formatted: formatDateTime(date, toTimezone),
          },
          difference: {
            hours: diffHours,
            minutes: diffMinutes,
            description:
              diffHours === 0
                ? "Same time"
                : `${toTimezone} is ${Math.abs(diffHours)} hour${Math.abs(diffHours) !== 1 ? "s" : ""} ${diffHours > 0 ? "ahead of" : "behind"} ${fromTimezone}`,
          },
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "timezone_converter",
      instructions:
        'You can convert times between timezones using the `timezone_converter` tool. Use IANA timezone names (e.g. "America/New_York") and "now" or ISO 8601 for the time.',
    };
  },
};

export default timezoneConverterSkill;
