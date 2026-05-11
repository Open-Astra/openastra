import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── CSV Analyzer Skill ──────────────────────────────────────────────
// Parse, filter, aggregate, and transform CSV data inline.
// No file I/O — operates on CSV text passed as parameters.

const ParseParams = z.object({
  csv: z.string().describe("Raw CSV text to parse"),
  delimiter: z.string().default(",").describe("Column delimiter (default: comma)"),
  hasHeader: z.boolean().default(true).describe("Whether first row is a header"),
  limit: z.number().int().min(1).max(1000).default(100).describe("Max rows to return"),
});

const AggregateParams = z.object({
  csv: z.string().describe("Raw CSV text"),
  groupBy: z.string().optional().describe("Column name to group by"),
  column: z.string().describe("Numeric column to aggregate"),
  operation: z.enum(["sum", "avg", "min", "max", "count"]).describe("Aggregation operation"),
  delimiter: z.string().default(","),
});

const FilterParams = z.object({
  csv: z.string().describe("Raw CSV text"),
  column: z.string().describe("Column name to filter on"),
  operator: z.enum(["eq", "ne", "gt", "lt", "gte", "lte", "contains", "starts_with"]).describe("Filter operator"),
  value: z.string().describe("Value to compare against"),
  delimiter: z.string().default(","),
});

function parseCSV(csv: string, delimiter: string, hasHeader: boolean): { headers: string[]; rows: string[][] } {
  const lines = csv.trim().split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return { headers: [], rows: [] };

  const split = (line: string) => {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;
    for (const char of line) {
      if (char === '"') { inQuotes = !inQuotes; continue; }
      if (char === delimiter && !inQuotes) { result.push(current.trim()); current = ""; continue; }
      current += char;
    }
    result.push(current.trim());
    return result;
  };

  const headers = hasHeader ? split(lines[0]!) : split(lines[0]!).map((_, i) => `col_${i}`);
  const dataLines = hasHeader ? lines.slice(1) : lines;
  const rows = dataLines.map((l) => split(l));

  return { headers, rows };
}

function rowToObj(headers: string[], row: string[]): Record<string, string> {
  const obj: Record<string, string> = {};
  headers.forEach((h, i) => { obj[h] = row[i] ?? ""; });
  return obj;
}

const csvAnalyzerSkill: SkillDefinition = {
  name: "csv_analyzer",
  version: "1.0.0",

  manifest: {
    id: "csv_analyzer",
    name: "CSV Analyzer",
    description: "Parse, filter, and aggregate CSV data. Operates on inline CSV text without file I/O.",
    category: "analyze",
    tools: ["csv_parse", "csv_aggregate", "csv_filter"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "csv_parse",
      description: "Parse CSV text into structured rows. Returns headers and data as JSON objects.",
      parameters: ParseParams,

      async execute(params) {
        const { headers, rows } = parseCSV(params.csv, params.delimiter, params.hasHeader);
        const limited = rows.slice(0, params.limit);
        return {
          headers,
          rowCount: rows.length,
          returned: limited.length,
          rows: limited.map((r) => rowToObj(headers, r)),
        };
      },
    });

    ctx.registerTool({
      name: "csv_aggregate",
      description: "Aggregate a numeric column with sum, avg, min, max, or count. Optionally group by another column.",
      parameters: AggregateParams,

      async execute(params) {
        const { headers, rows } = parseCSV(params.csv, params.delimiter, true);
        const colIdx = headers.indexOf(params.column);
        if (colIdx === -1) return { error: `Column "${params.column}" not found. Available: ${headers.join(", ")}` };

        const groupIdx = params.groupBy ? headers.indexOf(params.groupBy) : -1;
        if (params.groupBy && groupIdx === -1) return { error: `Group column "${params.groupBy}" not found.` };

        const groups = new Map<string, number[]>();
        for (const row of rows) {
          const key = groupIdx >= 0 ? (row[groupIdx] ?? "unknown") : "__all__";
          const val = parseFloat(row[colIdx] ?? "");
          if (isNaN(val)) continue;
          const arr = groups.get(key) ?? [];
          arr.push(val);
          groups.set(key, arr);
        }

        const compute = (values: number[]) => {
          switch (params.operation) {
            case "sum": return values.reduce((a, b) => a + b, 0);
            case "avg": return values.reduce((a, b) => a + b, 0) / values.length;
            case "min": return Math.min(...values);
            case "max": return Math.max(...values);
            case "count": return values.length;
          }
        };

        const results = [...groups.entries()].map(([key, values]) => ({
          group: key === "__all__" ? null : key,
          [params.operation]: Math.round(compute(values) * 1000) / 1000,
          count: values.length,
        }));

        return { column: params.column, operation: params.operation, groupBy: params.groupBy ?? null, results };
      },
    });

    ctx.registerTool({
      name: "csv_filter",
      description: "Filter CSV rows by a column condition. Returns matching rows.",
      parameters: FilterParams,

      async execute(params) {
        const { headers, rows } = parseCSV(params.csv, params.delimiter, true);
        const colIdx = headers.indexOf(params.column);
        if (colIdx === -1) return { error: `Column "${params.column}" not found. Available: ${headers.join(", ")}` };

        const filtered = rows.filter((row) => {
          const cell = row[colIdx] ?? "";
          const numCell = parseFloat(cell);
          const numVal = parseFloat(params.value);

          switch (params.operator) {
            case "eq": return cell === params.value;
            case "ne": return cell !== params.value;
            case "gt": return !isNaN(numCell) && !isNaN(numVal) && numCell > numVal;
            case "lt": return !isNaN(numCell) && !isNaN(numVal) && numCell < numVal;
            case "gte": return !isNaN(numCell) && !isNaN(numVal) && numCell >= numVal;
            case "lte": return !isNaN(numCell) && !isNaN(numVal) && numCell <= numVal;
            case "contains": return cell.toLowerCase().includes(params.value.toLowerCase());
            case "starts_with": return cell.toLowerCase().startsWith(params.value.toLowerCase());
          }
        });

        return {
          column: params.column,
          operator: params.operator,
          value: params.value,
          matchCount: filtered.length,
          totalRows: rows.length,
          rows: filtered.slice(0, 100).map((r) => rowToObj(headers, r)),
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "csv_analyzer",
      instructions: "You can analyze CSV data with `csv_parse` (parse to JSON), `csv_aggregate` (sum/avg/min/max/count with optional grouping), and `csv_filter` (filter rows by conditions). Pass CSV text directly.",
    };
  },
};

export default csvAnalyzerSkill;
