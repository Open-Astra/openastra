import { z } from "zod";
import { registerTool } from "./registry.js";

// ── parse-date-expression ────────────────────────────────────────────
// Parses natural language date expressions into ISO 8601 dates.
// Handles relative expressions like "next Monday", "in 3 days",
// "last week", "end of month", "yesterday", "tomorrow", etc.

const Params = z.object({
  expression: z
    .string()
    .max(200)
    .describe(
      "Natural language date expression to parse. Examples: 'next Monday', 'in 3 days', " +
      "'last week', 'end of month', 'yesterday', 'tomorrow', 'next Friday', '2 weeks from now'.",
    ),
  referenceDate: z
    .string()
    .optional()
    .describe("ISO 8601 reference date to resolve relative expressions from. Defaults to now."),
  timezone: z
    .string()
    .optional()
    .describe("IANA timezone for resolving expressions like 'end of day'. Defaults to UTC."),
});

// ── Relative expression parser ────────────────────────────────────

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function parseExpression(
  expr: string,
  ref: Date,
  _tz: string,
): { parsed: string; confidence: number } | null {
  const lower = expr.trim().toLowerCase();

  // Exact keywords
  if (lower === "now" || lower === "today") {
    return { parsed: ref.toISOString().split("T")[0]!, confidence: 1.0 };
  }
  if (lower === "tomorrow") {
    const d = new Date(ref);
    d.setUTCDate(d.getUTCDate() + 1);
    return { parsed: d.toISOString().split("T")[0]!, confidence: 1.0 };
  }
  if (lower === "yesterday") {
    const d = new Date(ref);
    d.setUTCDate(d.getUTCDate() - 1);
    return { parsed: d.toISOString().split("T")[0]!, confidence: 1.0 };
  }
  if (lower === "end of month" || lower === "end of the month") {
    const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 0));
    return { parsed: d.toISOString().split("T")[0]!, confidence: 0.95 };
  }
  if (lower === "start of month" || lower === "beginning of month" || lower === "start of the month") {
    const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1));
    return { parsed: d.toISOString().split("T")[0]!, confidence: 0.95 };
  }
  if (lower === "end of year" || lower === "end of the year") {
    const d = new Date(Date.UTC(ref.getUTCFullYear(), 11, 31));
    return { parsed: d.toISOString().split("T")[0]!, confidence: 0.95 };
  }
  if (lower === "start of year" || lower === "beginning of year") {
    const d = new Date(Date.UTC(ref.getUTCFullYear(), 0, 1));
    return { parsed: d.toISOString().split("T")[0]!, confidence: 0.95 };
  }

  // "in N days/weeks/months"
  const inMatch = lower.match(/^in\s+(\d+)\s+(day|days|week|weeks|month|months)$/);
  if (inMatch) {
    const n = parseInt(inMatch[1]!, 10);
    const unit = inMatch[2]!;
    const d = new Date(ref);
    if (unit.startsWith("day")) d.setUTCDate(d.getUTCDate() + n);
    else if (unit.startsWith("week")) d.setUTCDate(d.getUTCDate() + n * 7);
    else if (unit.startsWith("month")) d.setUTCMonth(d.getUTCMonth() + n);
    return { parsed: d.toISOString().split("T")[0]!, confidence: 0.98 };
  }

  // "N days/weeks/months from now" or "N days/weeks ago"
  const fromNowMatch = lower.match(/^(\d+)\s+(day|days|week|weeks|month|months)\s+from\s+now$/);
  if (fromNowMatch) {
    const n = parseInt(fromNowMatch[1]!, 10);
    const unit = fromNowMatch[2]!;
    const d = new Date(ref);
    if (unit.startsWith("day")) d.setUTCDate(d.getUTCDate() + n);
    else if (unit.startsWith("week")) d.setUTCDate(d.getUTCDate() + n * 7);
    else if (unit.startsWith("month")) d.setUTCMonth(d.getUTCMonth() + n);
    return { parsed: d.toISOString().split("T")[0]!, confidence: 0.98 };
  }

  const agoMatch = lower.match(/^(\d+)\s+(day|days|week|weeks|month|months)\s+ago$/);
  if (agoMatch) {
    const n = parseInt(agoMatch[1]!, 10);
    const unit = agoMatch[2]!;
    const d = new Date(ref);
    if (unit.startsWith("day")) d.setUTCDate(d.getUTCDate() - n);
    else if (unit.startsWith("week")) d.setUTCDate(d.getUTCDate() - n * 7);
    else if (unit.startsWith("month")) d.setUTCMonth(d.getUTCMonth() - n);
    return { parsed: d.toISOString().split("T")[0]!, confidence: 0.98 };
  }

  // "next <day>" or "last <day>"
  const nextDayMatch = lower.match(/^(next|last)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/);
  if (nextDayMatch) {
    const direction = nextDayMatch[1]!; // "next" or "last"
    const targetDay = DAY_NAMES.indexOf(nextDayMatch[2]!);
    const currentDay = ref.getUTCDay();
    let diff = targetDay - currentDay;
    if (direction === "next") {
      if (diff <= 0) diff += 7;
    } else {
      if (diff >= 0) diff -= 7;
    }
    const d = new Date(ref);
    d.setUTCDate(d.getUTCDate() + diff);
    return { parsed: d.toISOString().split("T")[0]!, confidence: 0.95 };
  }

  // "last week" / "next week"
  if (lower === "last week") {
    const d = new Date(ref);
    d.setUTCDate(d.getUTCDate() - 7);
    return { parsed: d.toISOString().split("T")[0]!, confidence: 0.85 };
  }
  if (lower === "next week") {
    const d = new Date(ref);
    d.setUTCDate(d.getUTCDate() + 7);
    return { parsed: d.toISOString().split("T")[0]!, confidence: 0.85 };
  }

  // "this <day>"
  const thisDayMatch = lower.match(/^this\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/);
  if (thisDayMatch) {
    const targetDay = DAY_NAMES.indexOf(thisDayMatch[1]!);
    const currentDay = ref.getUTCDay();
    let diff = targetDay - currentDay;
    if (diff < 0) diff += 7; // treat as upcoming if passed
    const d = new Date(ref);
    d.setUTCDate(d.getUTCDate() + diff);
    return { parsed: d.toISOString().split("T")[0]!, confidence: 0.85 };
  }

  // ISO date passthrough "YYYY-MM-DD"
  if (/^\d{4}-\d{2}-\d{2}$/.test(lower)) {
    return { parsed: lower, confidence: 1.0 };
  }

  return null;
}

registerTool({
  name: "parse-date-expression",
  description:
    "Parses natural language date expressions into ISO 8601 dates (YYYY-MM-DD). " +
    "Handles: 'next Monday', 'in 3 days', 'last week', 'end of month', 'yesterday', 'tomorrow', " +
    "'2 weeks from now', 'start of month', 'next Friday', etc. " +
    "Returns the parsed ISO date and a confidence score (0-1).",
  parameters: Params,
  async execute(params) {
    const tz = params.timezone ?? "UTC";
    const ref = params.referenceDate ? new Date(params.referenceDate) : new Date();

    if (isNaN(ref.getTime())) {
      return { error: `Invalid referenceDate: "${params.referenceDate}"` };
    }

    const result = parseExpression(params.expression, ref, tz);

    if (!result) {
      return {
        expression: params.expression,
        parsed: null,
        confidence: 0,
        error: `Could not parse expression: "${params.expression}". Try formats like "next Monday", "in 3 days", "yesterday", "end of month".`,
      };
    }

    return {
      expression: params.expression,
      parsed: result.parsed,
      confidence: result.confidence,
      referenceDate: ref.toISOString().split("T")[0]!,
    };
  },
});
