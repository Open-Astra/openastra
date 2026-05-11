import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── Log Analyzer Skill ──────────────────────────────────────────────
// Parse, filter, and analyze log data. Supports common log formats.

const ParseLogsParams = z.object({
  logs: z.string().describe("Raw log text to parse"),
  format: z.enum(["auto", "json", "apache", "syslog", "custom"]).default("auto"),
  limit: z.number().int().min(1).max(500).default(100),
});

const FilterLogsParams = z.object({
  logs: z.string().describe("Raw log text"),
  level: z.enum(["error", "warn", "info", "debug", "all"]).default("error").describe("Log level to filter for"),
  pattern: z.string().optional().describe("Regex pattern to match"),
  timeRange: z.object({
    from: z.string().optional(),
    to: z.string().optional(),
  }).optional(),
});

const AnalyzeLogsParams = z.object({
  logs: z.string().describe("Raw log text to analyze"),
});

interface LogEntry {
  timestamp?: string;
  level?: string;
  message: string;
  raw: string;
}

function parseLine(line: string): LogEntry {
  // Try JSON format
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    return {
      timestamp: String(parsed.timestamp ?? parsed.time ?? parsed.ts ?? ""),
      level: String(parsed.level ?? parsed.severity ?? ""),
      message: String(parsed.message ?? parsed.msg ?? parsed.text ?? line),
      raw: line,
    };
  } catch { /* not JSON */ }

  // Try common log patterns
  const patterns = [
    // ISO timestamp + level: 2025-01-01T00:00:00Z [ERROR] message
    /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[^\]]*?)\s*\[?(\w+)\]?\s*[:-]?\s*(.+)$/,
    // Syslog: Jan  1 00:00:00 host process: message
    /^(\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+\S+\s+\S+:\s*(.+)$/,
    // Apache: 127.0.0.1 - - [01/Jan/2025:00:00:00 +0000] "GET / HTTP/1.1" 200 1234
    /^\S+\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"(.+)"\s+(\d+)\s+(\d+)$/,
  ];

  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (match) {
      return {
        timestamp: match[1]?.trim(),
        level: match[2]?.trim(),
        message: match[3] ?? match[2] ?? line,
        raw: line,
      };
    }
  }

  // Detect level from text
  const levelMatch = line.match(/\b(ERROR|WARN(?:ING)?|INFO|DEBUG|FATAL|CRITICAL|TRACE)\b/i);

  return {
    level: levelMatch?.[1]?.toUpperCase(),
    message: line,
    raw: line,
  };
}

const logAnalyzerSkill: SkillDefinition = {
  name: "log_analyzer",
  version: "1.0.0",

  manifest: {
    id: "log_analyzer",
    name: "Log Analyzer",
    description: "Parse, filter, and analyze log data. Supports JSON, Apache, syslog, and custom formats.",
    category: "analyze",
    tools: ["log_parse", "log_filter", "log_analyze"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "log_parse",
      description: "Parse raw log text into structured entries with timestamp, level, and message.",
      parameters: ParseLogsParams,

      async execute(params) {
        const lines = params.logs.split("\n").filter((l) => l.trim());
        const entries = lines.slice(0, params.limit).map(parseLine);
        return { count: entries.length, totalLines: lines.length, entries };
      },
    });

    ctx.registerTool({
      name: "log_filter",
      description: "Filter logs by level, pattern, or time range.",
      parameters: FilterLogsParams,

      async execute(params) {
        const lines = params.logs.split("\n").filter((l) => l.trim());
        let entries = lines.map(parseLine);

        // Filter by level
        if (params.level !== "all") {
          const levelMap: Record<string, Set<string>> = {
            error: new Set(["ERROR", "FATAL", "CRITICAL"]),
            warn: new Set(["WARN", "WARNING"]),
            info: new Set(["INFO"]),
            debug: new Set(["DEBUG", "TRACE"]),
          };
          const allowed = levelMap[params.level] ?? new Set();
          entries = entries.filter((e) => e.level && allowed.has(e.level.toUpperCase()));
        }

        // Filter by pattern
        if (params.pattern) {
          try {
            const regex = new RegExp(params.pattern, "i");
            entries = entries.filter((e) => regex.test(e.message) || regex.test(e.raw));
          } catch { /* invalid regex, skip filter */ }
        }

        return { matched: entries.length, totalLines: lines.length, entries: entries.slice(0, 100) };
      },
    });

    ctx.registerTool({
      name: "log_analyze",
      description: "Analyze log data: count by level, find most common errors, detect patterns.",
      parameters: AnalyzeLogsParams,

      async execute(params) {
        const lines = params.logs.split("\n").filter((l) => l.trim());
        const entries = lines.map(parseLine);

        // Count by level
        const byLevel: Record<string, number> = {};
        for (const e of entries) {
          const level = e.level?.toUpperCase() ?? "UNKNOWN";
          byLevel[level] = (byLevel[level] ?? 0) + 1;
        }

        // Find repeated error messages
        const errorMessages = new Map<string, number>();
        for (const e of entries) {
          if (e.level && ["ERROR", "FATAL", "CRITICAL"].includes(e.level.toUpperCase())) {
            // Normalize message (remove timestamps, IDs, numbers)
            const normalized = e.message.replace(/\d{4}-\d{2}-\d{2}/g, "DATE").replace(/\b\d+\b/g, "N").slice(0, 100);
            errorMessages.set(normalized, (errorMessages.get(normalized) ?? 0) + 1);
          }
        }

        const topErrors = [...errorMessages.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([msg, count]) => ({ message: msg, count }));

        return {
          totalLines: lines.length,
          byLevel,
          errorCount: (byLevel.ERROR ?? 0) + (byLevel.FATAL ?? 0) + (byLevel.CRITICAL ?? 0),
          warnCount: byLevel.WARN ?? byLevel.WARNING ?? 0,
          topErrors,
          hasTimestamps: entries.some((e) => e.timestamp),
          timeRange: {
            first: entries[0]?.timestamp,
            last: entries[entries.length - 1]?.timestamp,
          },
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "log_analyzer",
      instructions: "You can analyze logs with `log_parse` (structure raw logs), `log_filter` (filter by level/pattern), and `log_analyze` (statistics and top errors). Supports JSON, Apache, syslog formats.",
    };
  },
};

export default logAnalyzerSkill;
