import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── Cron Parser Skill ───────────────────────────────────────────────
// Parse, validate, and explain cron expressions. Show next N runs.

const ParseCronParams = z.object({
  expression: z.string().describe("Cron expression (e.g. '0 9 * * 1-5')"),
  nextRuns: z.number().int().min(1).max(20).default(5).describe("Number of future runs to calculate"),
});

const BuildCronParams = z.object({
  description: z.string().describe("Natural language schedule (e.g. 'every weekday at 9am', 'every 5 minutes')"),
});

const FIELD_NAMES = ["minute", "hour", "day of month", "month", "day of week"];
const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function explainField(value: string, fieldIdx: number): string {
  const name = FIELD_NAMES[fieldIdx]!;
  if (value === "*") return `every ${name}`;
  if (value.includes("/")) {
    const [, step] = value.split("/");
    return `every ${step} ${name}(s)`;
  }
  if (value.includes("-")) {
    const [start, end] = value.split("-");
    if (fieldIdx === 4) return `${DOW_NAMES[parseInt(start!, 10)] ?? start} through ${DOW_NAMES[parseInt(end!, 10)] ?? end}`;
    return `${name} ${start} through ${end}`;
  }
  if (value.includes(",")) {
    const parts = value.split(",");
    if (fieldIdx === 4) return `on ${parts.map((p) => DOW_NAMES[parseInt(p, 10)] ?? p).join(", ")}`;
    return `${name} ${parts.join(", ")}`;
  }
  if (fieldIdx === 4) return `on ${DOW_NAMES[parseInt(value, 10)] ?? value}`;
  if (fieldIdx === 3) return `in ${MONTH_NAMES[parseInt(value, 10)] ?? value}`;
  return `at ${name} ${value}`;
}

function getNextRuns(fields: string[], count: number): string[] {
  const runs: string[] = [];
  const now = new Date();
  const date = new Date(now);
  date.setSeconds(0);
  date.setMilliseconds(0);
  date.setMinutes(date.getMinutes() + 1);

  const matches = (val: string, current: number, _max: number): boolean => {
    if (val === "*") return true;
    if (val.includes("/")) {
      const step = parseInt(val.split("/")[1]!, 10);
      return current % step === 0;
    }
    if (val.includes(",")) return val.split(",").map(Number).includes(current);
    if (val.includes("-")) {
      const [s, e] = val.split("-").map(Number) as [number, number];
      return current >= s && current <= e;
    }
    return parseInt(val, 10) === current;
  };

  let iterations = 0;
  while (runs.length < count && iterations < 525600) { // max 1 year of minutes
    iterations++;
    const [minute, hour, dom, month, dow] = fields;
    if (
      matches(minute!, date.getMinutes(), 59) &&
      matches(hour!, date.getHours(), 23) &&
      matches(dom!, date.getDate(), 31) &&
      matches(month!, date.getMonth() + 1, 12) &&
      matches(dow!, date.getDay(), 6)
    ) {
      runs.push(date.toISOString().replace("T", " ").slice(0, 16));
    }
    date.setMinutes(date.getMinutes() + 1);
  }

  return runs;
}

const cronParserSkill: SkillDefinition = {
  name: "cron_parser",
  version: "1.0.0",

  manifest: {
    id: "cron_parser",
    name: "Cron Parser",
    description: "Parse, validate, and explain cron expressions. Calculate next scheduled runs.",
    category: "analyze",
    tools: ["cron_parse", "cron_build"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "cron_parse",
      description: "Parse a cron expression. Returns human-readable explanation and next scheduled runs.",
      parameters: ParseCronParams,

      async execute(params, _toolCtx) {
        const fields = params.expression.trim().split(/\s+/);
        if (fields.length !== 5) return { error: `Expected 5 fields (minute hour dom month dow), got ${fields.length}` };

        const explanation = fields.map((f, i) => explainField(f, i));
        const nextRuns = getNextRuns(fields, params.nextRuns);

        return {
          expression: params.expression,
          fields: { minute: fields[0], hour: fields[1], dayOfMonth: fields[2], month: fields[3], dayOfWeek: fields[4] },
          explanation: explanation.join(", "),
          humanReadable: explanation.filter((e) => !e.startsWith("every")).join(", ") || explanation.join(", "),
          nextRuns,
        };
      },
    });

    ctx.registerTool({
      name: "cron_build",
      description: "Build a cron expression from a natural language description.",
      parameters: BuildCronParams,

      async execute(params, _toolCtx) {
        const d = params.description.toLowerCase();
        let expression = "";
        let explanation = "";

        if (d.includes("every minute")) { expression = "* * * * *"; explanation = "Every minute"; }
        else if (d.match(/every (\d+) minutes?/)) { const m = d.match(/every (\d+) minutes?/)![1]; expression = `*/${m} * * * *`; explanation = `Every ${m} minutes`; }
        else if (d.match(/every (\d+) hours?/)) { const h = d.match(/every (\d+) hours?/)![1]; expression = `0 */${h} * * *`; explanation = `Every ${h} hours`; }
        else if (d.includes("every hour")) { expression = "0 * * * *"; explanation = "Every hour at minute 0"; }
        else if (d.includes("weekday") && d.match(/at (\d+)/)) { const h = d.match(/at (\d+)/)![1]; expression = `0 ${h} * * 1-5`; explanation = `Weekdays at ${h}:00`; }
        else if (d.includes("daily") || d.includes("every day")) {
          const hMatch = d.match(/at (\d+)/);
          const h = hMatch ? hMatch[1] : "0";
          expression = `0 ${h} * * *`;
          explanation = `Daily at ${h}:00`;
        }
        else if (d.includes("weekly") || d.includes("every week")) { expression = "0 0 * * 0"; explanation = "Weekly on Sunday at midnight"; }
        else if (d.includes("monthly")) { expression = "0 0 1 * *"; explanation = "Monthly on the 1st at midnight"; }
        else if (d.includes("midnight")) { expression = "0 0 * * *"; explanation = "Daily at midnight"; }
        else if (d.includes("noon")) { expression = "0 12 * * *"; explanation = "Daily at noon"; }
        else {
          return { error: "Could not parse schedule description. Try: 'every 5 minutes', 'every weekday at 9', 'daily at 8', 'every hour', 'monthly', 'midnight', 'noon'." };
        }

        return { description: params.description, expression, explanation, nextRuns: getNextRuns(expression.split(" "), 3) };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "cron_parser",
      instructions: "You can work with cron expressions using `cron_parse` (explain and show next runs) and `cron_build` (create from natural language description).",
    };
  },
};

export default cronParserSkill;
